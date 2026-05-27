const { createApp, ref, reactive, computed, watch, nextTick, onMounted } = Vue;

const API = '';

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

createApp({
  setup() {
    const site = ref('');
    const component = ref('');
    const sites = ref([]);
    const components = ref([]);
    const tab = ref('generate');
    const settingsTab = ref('component');
    const jobsOpen = ref(true);
    const jobs = ref([]);
    const showRunTroubleshoot = ref(false);

    const tabs = [
      { id: 'discover', label: 'Connect Target' },
      { id: 'generate', label: 'Generate Tests' },
      { id: 'payloads', label: 'Payloads' },
      { id: 'tests', label: 'Test Management' },
      { id: 'run', label: 'Run Tests' },
      { id: 'risk', label: 'Finding Assessment' },
      { id: 'export', label: 'Submit Findings' },
      { id: 'settings', label: 'Settings' },
    ];

    const PAYLOAD_GENERATORS = [
      'text', 'csv', 'pdf', 'pdf_visible', 'pdf_hidden', 'pdf_metadata',
      'image', 'image_text', 'qr', 'audio_synthetic', 'audio_tts',
    ];

    const allStrategies = ref([]);
    const allPlaybooks = ref([]);
    const runStrategies = ref([]);
    const runPlaybooks = ref([]);
    const runAllPlaybooks = ref([]);
    const logs = reactive({ runs: [], attacks: [], reports: [] });

    // --- Test Management tab ---
    const tmStrategy = ref('');
    const tmPlaybook = ref('');
    const tmStrategies = ref([]);
    const tmPlaybooks = ref([]);
    const tmFile = ref(null);       // loaded test file { playbook, description, categories }
    const tmDirty = ref(false);
    const tmSaving = ref(false);
    const tmSaveMsg = ref('');
    const tmEditingId = ref(null);  // prompt id being inline-edited
    const tmAddingCategory = ref('');// category slug for new-prompt form
    const tmNewPrompt = reactive({
      id: '', description: '', prompt: '', vector_type: 'text_direct',
      payload_generator: 'text', payload_args_json: '{}',
    });
    const tmPayloadGenMsg = ref('');
    const tmPayloadGenBusy = ref(false);
    const tmImportFile = ref(null);
    const tmImportName = ref('');
    const tmImporting = ref(false);
    const tmImportMsg = ref('');

    const TM_MULTI_TURN_STRATEGIES = new Set(['multi_shot', 'iterative', 'prompt_chaining']);
    const TM_FEW_SHOT_STRATEGIES = new Set(['few_shot']);
    const TM_EXAMPLE_BEHAVIORS = ['comply', 'refuse'];

    function tmStrategyNorm() {
      return (tmStrategy.value || '').replace(/-/g, '_');
    }

    function tmIsMultiTurnStrategy() {
      return TM_MULTI_TURN_STRATEGIES.has(tmStrategyNorm());
    }

    function tmIsFewShotStrategy() {
      return TM_FEW_SHOT_STRATEGIES.has(tmStrategyNorm());
    }

    function tmIsMultimodalStrategy() {
      return tmStrategyNorm() === 'multimodal';
    }

    function tmPromptKind(p) {
      if (Array.isArray(p?.prompts) && p.prompts.length) return 'multi_turn';
      if (Array.isArray(p?.examples) && p.examples.length) return 'few_shot';
      if (p?.payload || (p?.vector_type && p.vector_type !== 'text_direct')) return 'multimodal';
      return 'text';
    }

    function tmPromptKindLabel(p) {
      const labels = {
        multi_turn: `${p.prompts?.length || 0}-turn`,
        few_shot: `few-shot (${p.examples?.length || 0})`,
        multimodal: p.vector_type || 'artifact',
        text: '',
      };
      return labels[tmPromptKind(p)] || '';
    }

    function tmPromptPreview(p) {
      const kind = tmPromptKind(p);
      const clip = (s, n = 220) => {
        const t = (s || '').trim();
        return t.length <= n ? t : t.slice(0, n) + '…';
      };
      if (kind === 'multi_turn') {
        const turns = p.prompts || [];
        if (turns.length === 1) return clip(turns[0]);
        return turns.map((t, i) => `Turn ${i + 1}: ${clip(t, 120)}`).join('\n');
      }
      if (kind === 'few_shot') {
        const ex = p.examples || [];
        const lines = ex.map((e, i) => `Ex ${i + 1}: ${clip(e.prompt, 80)}`);
        if (p.prompt) lines.push(`Final: ${clip(p.prompt, 120)}`);
        return lines.join('\n');
      }
      return clip(p.prompt);
    }

    function tmNormalizeSuite(data) {
      if (!data || !Array.isArray(data.categories)) return data;
      for (const cat of data.categories) {
        if (!cat.name && cat.category) cat.name = cat.category;
        if (!cat.name && cat.mandate) cat.name = cat.mandate;
      }
      return data;
    }

    function tmAddTurn(p) {
      if (!Array.isArray(p.prompts)) p.prompts = [];
      p.prompts.push('');
      tmMarkDirty();
    }

    function tmRemoveTurn(p, turnIdx) {
      if (!Array.isArray(p.prompts)) return;
      p.prompts.splice(turnIdx, 1);
      tmMarkDirty();
    }

    function tmAddExample(p) {
      if (!Array.isArray(p.examples)) p.examples = [];
      p.examples.push({ prompt: '', expected_behavior: 'comply' });
      tmMarkDirty();
    }

    function tmRemoveExample(p, exampleIdx) {
      if (!Array.isArray(p.examples)) return;
      p.examples.splice(exampleIdx, 1);
      tmMarkDirty();
    }

    // --- Payloads tab ---
    const payloadTypes = ref([]);
    const payloadAssetType = ref('text');
    const payloadForm = reactive({});
    const payloadFiles = ref([]);
    const payloadGenBusy = ref(false);
    const payloadGenResult = ref(null);
    const payloadGenError = ref('');

    async function loadPayloadTypes() {
      try {
        const res = await api('/api/payloads/types');
        payloadTypes.value = res.types || [];
        if (payloadTypes.value.length && !payloadAssetType.value) {
          payloadAssetType.value = payloadTypes.value[0].asset_type;
        }
        resetPayloadForm();
      } catch (_) {
        payloadTypes.value = [];
      }
    }

    function resetPayloadForm() {
      const t = payloadTypes.value.find(x => x.asset_type === payloadAssetType.value);
      Object.keys(payloadForm).forEach(k => delete payloadForm[k]);
      if (!t) return;
      for (const f of t.fields || []) {
        payloadForm[f.name] = f.default !== undefined ? f.default : (f.type === 'bool' ? false : '');
      }
    }

    watch(payloadAssetType, () => resetPayloadForm());

    async function loadPayloadFiles() {
      try {
        const res = await api('/api/payloads/list');
        payloadFiles.value = res.files || [];
      } catch (_) {
        payloadFiles.value = [];
      }
    }

    async function generatePayloadAsset() {
      payloadGenBusy.value = true;
      payloadGenError.value = '';
      payloadGenResult.value = null;
      try {
        const body = { asset_type: payloadAssetType.value, ...payloadForm };
        const res = await api('/api/payloads/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        payloadGenResult.value = res;
        await loadPayloadFiles();
      } catch (e) {
        payloadGenError.value = e.message;
      } finally {
        payloadGenBusy.value = false;
      }
    }

    function payloadDownloadUrl(relativePath) {
      return `/api/payloads/file/${encodeURIComponent(relativePath)}`;
    }

    async function tmLoadStrategies() {
      tmStrategies.value = [];
      tmStrategy.value = '';
      tmPlaybooks.value = [];
      tmPlaybook.value = '';
      tmFile.value = null;
      if (!site.value || !component.value) return;
      const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
      tmStrategies.value = await api(`/api/sites/${s}/${c}/strategies`);
    }

    async function tmLoadPlaybooks() {
      tmPlaybooks.value = [];
      tmPlaybook.value = '';
      tmFile.value = null;
      tmDirty.value = false;
      if (tmStrategy.value && site.value && component.value) {
        const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
        tmPlaybooks.value = await api(`/api/sites/${s}/${c}/strategies/${encodeURIComponent(tmStrategy.value)}/playbooks`);
      }
    }

    async function tmLoadFile() {
      tmFile.value = null;
      tmDirty.value = false;
      tmEditingId.value = null;
      tmAddingCategory.value = '';
      if (!tmPlaybook.value || !tmStrategy.value) return;
      const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
      const fw = encodeURIComponent(tmPlaybook.value);
      const strat = encodeURIComponent(tmStrategy.value);
      // tmPlaybook.value holds the full path; extract stem from it
      const stem = tmPlaybook.value.split('/').pop().replace(/\.json$/, '');
      tmFile.value = tmNormalizeSuite(await api(`/api/sites/${s}/${c}/tests/${strat}/${encodeURIComponent(stem)}`));
    }

    function tmSnapshotPlain() {
      const data = JSON.parse(JSON.stringify(tmFile.value));
      for (const cat of data.categories || []) {
        if (cat.category && !cat.name) cat.name = cat.category;
        delete cat.category;
      }
      return data;
    }

    async function tmSave() {
      if (!tmFile.value) return;
      tmSaving.value = true;
      tmSaveMsg.value = '';
      try {
        const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
        const strat = encodeURIComponent(tmStrategy.value);
        const stem = tmPlaybook.value.split('/').pop().replace(/\.json$/, '');
        await api(`/api/sites/${s}/${c}/tests/${strat}/${encodeURIComponent(stem)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: tmSnapshotPlain() }),
        });
        tmDirty.value = false;
        tmSaveMsg.value = 'Saved';
        setTimeout(() => { tmSaveMsg.value = ''; }, 2000);
      } catch (e) {
        tmSaveMsg.value = 'Save failed: ' + e.message;
      } finally {
        tmSaving.value = false;
      }
    }

    async function tmDeletePrompt(categoryIdx, promptIdx) {
      const m = tmFile.value.categories[categoryIdx];
      if (!m?.prompts?.length) return;
      if (promptIdx < 0 || promptIdx >= m.prompts.length) return;
      m.prompts = m.prompts.filter((_, i) => i !== promptIdx);
      tmDirty.value = true;
      await tmSave();
    }

    function tmStartAdd(categorySlug) {
      tmAddingCategory.value = categorySlug;
      tmNewPrompt.id = '';
      tmNewPrompt.description = '';
      tmNewPrompt.prompt = '';
      tmNewPrompt.vector_type = 'text_direct';
      tmNewPrompt.payload_generator = 'text';
      tmNewPrompt.payload_args_json = '{}';
    }

    function tmBuildPayloadFromEditor(src) {
      if (!src.payload_generator || src.payload_generator === 'none') return undefined;
      let args = {};
      try {
        args = JSON.parse(src.payload_args_json || '{}');
      } catch (_) {
        args = {};
      }
      return { generator: src.payload_generator, args };
    }

    async function tmGeneratePayloadForPrompt(p) {
      const gen = p.payload?.generator || p.payload_generator;
      if (!gen || gen === 'none') return;
      tmPayloadGenBusy.value = true;
      tmPayloadGenMsg.value = '';
      let args = p.payload?.args;
      if (!args && p.payload_args_json) {
        try {
          args = JSON.parse(p.payload_args_json || '{}');
        } catch (e) {
          tmPayloadGenMsg.value = 'Invalid payload args JSON';
          tmPayloadGenBusy.value = false;
          return;
        }
      }
      args = args || {};
      try {
        const res = await api('/api/payloads/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ generator: gen, args }),
        });
        tmPayloadGenMsg.value = 'Generated: ' + (res.relative_path || res.path);
        if (res.relative_path && p.payload) {
          p.payload.path = res.relative_path;
          tmMarkDirty();
        }
      } catch (e) {
        tmPayloadGenMsg.value = 'Generate failed: ' + e.message;
      } finally {
        tmPayloadGenBusy.value = false;
      }
    }

    function tmConfirmAdd(categoryIdx) {
      const id = tmNewPrompt.id.trim();
      const description = tmNewPrompt.description.trim();
      const text = tmNewPrompt.prompt.trim();
      if (!id) return;

      const p = { id, description };
      if (tmIsMultiTurnStrategy()) {
        const turns = text.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
        if (!turns.length) return;
        p.prompts = turns;
      } else if (tmIsFewShotStrategy()) {
        if (!text) return;
        p.examples = [];
        p.prompt = text;
      } else {
        if (!text) return;
        p.prompt = text;
        if (tmIsMultimodalStrategy()) {
          if (tmNewPrompt.vector_type && tmNewPrompt.vector_type !== 'text_direct') {
            p.vector_type = tmNewPrompt.vector_type;
          }
          const payload = tmBuildPayloadFromEditor(tmNewPrompt);
          if (payload) p.payload = payload;
        }
      }

      tmFile.value.categories[categoryIdx].prompts.push(p);
      tmDirty.value = true;
      tmAddingCategory.value = '';
    }

    function tmMarkDirty() { tmDirty.value = true; }

    function tmImportFileChanged(event) {
      const file = event.target.files?.[0] || null;
      tmImportFile.value = file;
      tmImportMsg.value = '';
      if (file && !tmImportName.value) {
        tmImportName.value = file.name.replace(/\.json$/i, '');
      }
    }

    function tmReadImportFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(JSON.parse(reader.result));
          } catch (e) {
            reject(new Error('Invalid JSON: ' + e.message));
          }
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsText(file);
      });
    }

    async function tmImportZeroShot() {
      if (!site.value || !component.value || !tmImportFile.value) return;
      if (tmDirty.value && !confirm('Discard unsaved test edits and open the imported file?')) return;
      tmImporting.value = true;
      tmImportMsg.value = '';
      try {
        const data = await tmReadImportFile(tmImportFile.value);
        const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
        const result = await api(`/api/sites/${s}/${c}/tests/import-zero-shot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: tmImportName.value || tmImportFile.value.name, data }),
        });
        await tmLoadStrategies();
        tmStrategy.value = result.strategy;
        await tmLoadPlaybooks();
        tmPlaybook.value = result.path;
        await tmLoadFile();
        tmImportMsg.value = `Imported ${result.playbook} into Zero-shot`;
      } catch (e) {
        tmImportMsg.value = 'Import failed: ' + e.message;
      } finally {
        tmImporting.value = false;
      }
    }

    const STRATEGY_DEFAULT_PLAYBOOK = {
      multimodal: 'owasp_llm',
      jailbreak: 'jailbreak_core',
    };

    const gen = reactive({ strategy: '__all__', playbook: 'owasp_llm' });
    const showPlaybookModal = ref(false);
    const pbGenerating = ref(false);
    const pbError = ref('');
    const pbMsg = ref('');
    const pbForm = reactive({
      playbook_id: '',
      name: '',
      topic: '',
      assessment_focus: '',
      category_count: 8,
      overwrite: false,
    });
    const pbIdTouched = ref(false);

    function pbSlugify(text) {
      return (text || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
    }

    function pbSuggestId() {
      if (pbIdTouched.value) return;
      pbForm.playbook_id = pbSlugify(pbForm.name);
    }

    function openPlaybookModal() {
      pbError.value = '';
      pbMsg.value = '';
      pbIdTouched.value = false;
      pbForm.playbook_id = '';
      pbForm.name = '';
      pbForm.topic = '';
      pbForm.assessment_focus = '';
      pbForm.category_count = 8;
      pbForm.overwrite = false;
      showPlaybookModal.value = true;
    }

    function closePlaybookModal() {
      if (pbGenerating.value) return;
      showPlaybookModal.value = false;
    }

    async function submitPlaybookGenerate() {
      pbError.value = '';
      pbMsg.value = '';
      const playbook_id = pbSlugify(pbForm.playbook_id);
      const topic = pbForm.topic.trim();
      if (!playbook_id) {
        pbError.value = 'Enter a playbook ID.';
        return;
      }
      if (topic.length < 10) {
        pbError.value = 'Topic must be at least 10 characters.';
        return;
      }
      pbGenerating.value = true;
      try {
        const result = await api('/api/playbooks/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playbook_id,
            name: pbForm.name.trim(),
            topic,
            assessment_focus: pbForm.assessment_focus.trim(),
            category_count: pbForm.category_count,
            overwrite: pbForm.overwrite,
          }),
        });
        allPlaybooks.value = await api('/api/playbooks');
        gen.playbook = result.playbook_id;
        pbMsg.value = `Created ${result.category_count} categories → ${result.path}`;
        setTimeout(() => {
          showPlaybookModal.value = false;
          pbMsg.value = '';
        }, 1200);
      } catch (e) {
        pbError.value = 'Generate failed: ' + e.message;
      } finally {
        pbGenerating.value = false;
      }
    }

    const run = reactive({ strategy: '', playbook: '', assess: false });
    const runArtifactStatus = ref([]);
    const runUploadWarning = ref('');
    const risk = reactive({ log: '' });
    const RISK_TIME_WINDOWS = [
      { id: '1h', label: 'Last hour', seconds: 3600 },
      { id: '4h', label: 'Last 4 hours', seconds: 14400 },
      { id: '24h', label: 'Last 24 hours (daily)', seconds: 86400 },
    ];
    const EXPORT_RISK_LEVELS = [
      { id: 'critical', label: 'Critical' },
      { id: 'high', label: 'High' },
      { id: 'medium', label: 'Medium' },
      { id: 'low', label: 'Low' },
      { id: 'informational', label: 'Informational' },
      { id: 'indeterminate', label: 'Indeterminate' },
    ];
    const RISK_WINDOW_PREFIX = '__window:';

    function riskWindowValue(windowId) {
      return `${RISK_WINDOW_PREFIX}${windowId}`;
    }

    function riskWindowIdFromValue(value) {
      if (!value || !value.startsWith(RISK_WINDOW_PREFIX)) return '';
      return value.slice(RISK_WINDOW_PREFIX.length);
    }

    const riskWindowCounts = computed(() => {
      const now = Date.now() / 1000;
      const attacks = logs.attacks || [];
      const counts = {};
      for (const w of RISK_TIME_WINDOWS) {
        counts[w.id] = attacks.filter(a => (a.mtime || 0) >= now - w.seconds).length;
      }
      return counts;
    });

    const riskAssessEnabled = computed(() => {
      if (!risk.log) return false;
      const windowId = riskWindowIdFromValue(risk.log);
      if (windowId) return (riskWindowCounts.value[windowId] || 0) > 0;
      return true;
    });

    const exportWindowCounts = computed(() => {
      const now = Date.now() / 1000;
      const reports = logs.reports || [];
      const counts = {};
      for (const w of RISK_TIME_WINDOWS) {
        counts[w.id] = reports.filter(r => (r.mtime || 0) >= now - w.seconds).length;
      }
      return counts;
    });

    const exp = reactive({
      report: '',
      user_id: '',
      autoAfterAssess: false,
      riskLevels: {
        critical: true,
        high: true,
        medium: true,
        low: false,
        informational: false,
        indeterminate: false,
      },
    });
    const expSaved = ref(false);
    const expSaving = ref(false);
    const expSaveError = ref('');

    function normalizeExportRiskLevel(row) {
      const aliases = { compliant: 'low', mitigated: 'low' };
      const raw = String(row?.risk_level || '').trim().toLowerCase();
      const level = aliases[raw] || raw;
      return EXPORT_RISK_LEVELS.some(l => l.id === level) ? level : 'indeterminate';
    }

    const expSelectedRiskLevels = computed(() =>
      EXPORT_RISK_LEVELS.filter(l => exp.riskLevels[l.id]).map(l => l.id),
    );

    function countExportableResults(rows) {
      const allowed = new Set(expSelectedRiskLevels.value);
      if (!allowed.size) return 0;
      return (rows || []).filter(r => allowed.has(normalizeExportRiskLevel(r))).length;
    }

    function toggleExpRiskLevel(id) {
      exp.riskLevels[id] = !exp.riskLevels[id];
    }

    const exportEnabled = computed(() => {
      if (!exp.report || !expSelectedRiskLevels.value.length) return false;
      const windowId = riskWindowIdFromValue(exp.report);
      if (windowId) return (exportWindowCounts.value[windowId] || 0) > 0;
      if (expPreview.value && expPreview.value.exportCount === 0) return false;
      return true;
    });
    const expResult = ref(null);
    const expPreview = ref(null);
    // host + api_key stored server-side in .env; user_id is per-export
    const expCreds = reactive({ host: '', has_api_key: false });
    const expCredsEdit = reactive({ host: '', api_key: '' });
    const expCredsSaving = ref(false);
    const expCredsMsg = ref('');

    async function loadExpCreds() {
      try {
        const c = await api('/api/credentials');
        expCreds.host = c.host || '';
        expCreds.has_api_key = c.has_api_key || false;
        expCredsEdit.host = c.host || '';
        expCredsEdit.api_key = '';
      } catch { /* ignore */ }
    }

    function applyExportConfig(exportCfg) {
      const block = exportCfg || {};
      exp.autoAfterAssess = !!block.auto_after_assess;
      const levels = Array.isArray(block.risk_levels) ? block.risk_levels : [];
      for (const lvl of EXPORT_RISK_LEVELS) {
        exp.riskLevels[lvl.id] = levels.length ? levels.includes(lvl.id) : exp.riskLevels[lvl.id];
      }
      if (block.user_id) exp.user_id = block.user_id;
    }

    async function loadExportSettings() {
      if (!site.value || !component.value) return;
      expSaveError.value = '';
      try {
        await loadExpCreds();
        const data = await api(
          `/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`,
        );
        applyExportConfig(data.export);
        if (!exp.user_id) {
          const c = await api('/api/credentials');
          if (c.user_id) exp.user_id = c.user_id;
        }
      } catch (e) {
        expSaveError.value = String(e);
      }
    }

    async function saveExportSettings() {
      if (!site.value || !component.value) return;
      expSaving.value = true;
      expSaveError.value = '';
      expSaved.value = false;
      try {
        const existing = await api(
          `/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`,
        );
        const payload = {
          ...existing,
          export: {
            auto_after_assess: exp.autoAfterAssess,
            risk_levels: expSelectedRiskLevels.value,
            user_id: (exp.user_id || '').trim(),
          },
        };
        await api(
          `/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: payload }),
          },
        );
        expSaved.value = true;
        setTimeout(() => { expSaved.value = false; }, 3000);
      } catch (e) {
        expSaveError.value = String(e);
      } finally {
        expSaving.value = false;
      }
    }

    async function saveExpCreds() {
      expCredsSaving.value = true;
      expCredsMsg.value = '';
      try {
        const result = await api('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: expCredsEdit.host, api_key: expCredsEdit.api_key }),
        });
        expCreds.host = result.host;
        expCreds.has_api_key = result.has_api_key;
        expCredsEdit.api_key = '';
        expCredsMsg.value = 'Saved to .env';
      } catch (e) {
        expCredsMsg.value = 'Save failed: ' + e.message;
      } finally {
        expCredsSaving.value = false;
      }
    }

    async function clearExpCreds() {
      if (!confirm('Remove Genbounty credentials from .env?')) return;
      await api('/api/credentials', { method: 'DELETE' });
      expCreds.host = '';
      expCreds.has_api_key = false;
      expCredsEdit.host = expCredsEdit.api_key = '';
      expCredsMsg.value = 'Credentials cleared';
    }

    async function refreshExpPreview() {
      const path = exp.report;
      expPreview.value = null;
      if (!path) return;
      const windowId = riskWindowIdFromValue(path);
      const levels = expSelectedRiskLevels.value;
      if (windowId) {
        expPreview.value = {
          batchReports: exportWindowCounts.value[windowId] || 0,
          batchLabel: RISK_TIME_WINDOWS.find(w => w.id === windowId)?.label || windowId,
          riskLevels: levels,
        };
        return;
      }
      try {
        const data = await api(`/api/log?path=${encodeURIComponent(path)}`);
        const rows = data.adversarial_results || [];
        const exportCount = countExportableResults(rows);
        expPreview.value = {
          count: rows.length,
          exportCount,
          playbook: data.playbook || '',
          timestamp: data.timestamp || '',
          riskLevels: levels,
        };
      } catch { /* ignore */ }
    }

    watch(() => exp.report, async () => {
      expResult.value = null;
      await refreshExpPreview();
    });

    watch(expSelectedRiskLevels, async () => {
      await refreshExpPreview();
    });
    const cache = reactive({ deleteOnServer: false, useGeminiCache: false, effectiveGeminiCache: false, componentOverride: null });
    const cacheSettingsSaving = ref(false);
    const cacheSettingsMsg = ref('');

    async function loadCacheSettings() {
      try {
        let path = '/api/cache-settings';
        if (site.value && component.value) {
          const s = encodeURIComponent(site.value);
          const c = encodeURIComponent(component.value);
          path += `?site=${s}&component=${c}`;
        }
        const s = await api(path);
        cache.useGeminiCache = !!s.gemini_use_cache;
        cache.effectiveGeminiCache = !!s.effective_gemini_use_cache;
        cache.componentOverride = s.component_override;
      } catch { /* ignore */ }
    }

    async function saveCacheSettings() {
      cacheSettingsSaving.value = true;
      cacheSettingsMsg.value = '';
      try {
        const result = await api('/api/cache-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gemini_use_cache: cache.useGeminiCache }),
        });
        cache.useGeminiCache = !!result.gemini_use_cache;
        cacheSettingsMsg.value = cache.useGeminiCache ? 'Gemini cache enabled' : 'Gemini cache disabled';
      } catch (e) {
        cacheSettingsMsg.value = 'Save failed: ' + e.message;
      } finally {
        cacheSettingsSaving.value = false;
      }
    }

    // Component config
    const PROMPT_TEMPLATE_HINT = '{{prompt}}';
    const PROMPT_BODY_PLACEHOLDER = '{"prompt": "' + PROMPT_TEMPLATE_HINT + '"}';

    const INPUT_TYPES = ['text', 'textarea', 'contenteditable', 'password', 'email', 'search', 'select', 'combobox', 'checkbox', 'radio', 'file'];
    const compCfg = reactive({
      login_url: '',
      submission: {
        transport: 'ui',
        start_url: '', inputs: [], submit_selector: '', response_selector: '',
        response_within_selector: '', response_text_within_selector: '',
        submit_via: 'click', response_wait_ms: 5000,
        api_url: '', api_method: 'POST', api_response_path: 'response',
        api_body_json: '{\n  "prompt": "{{prompt}}"\n}',
        api_headers_json: '{}',
        upload_url: '', upload_file_field: 'file', upload_response_path: 'document_id',
        multipart_prompt_field: 'prompt', multipart_file_field: 'file',
      },
    });
    const settingsSchema = ref(null);
    const compSettings = reactive({});
    const compSettingsInherited = reactive({});
    const compCfgSaved = ref(false);
    const compCfgError = ref('');
    const compCfgEmpty = ref(false);

    function settingMeta(key) {
      return (settingsSchema.value?.meta || {})[key] || { type: 'string', label: key };
    }

    function settingLabel(key) {
      return settingMeta(key).label || key;
    }

    function formatSettingGlobal(key) {
      const val = settingsSchema.value?.globals?.[key];
      if (key === 'BLOCKED_TYPES') {
        const arr = Array.isArray(val) ? val : [];
        return arr.length ? arr.join(', ') : '(none)';
      }
      if (typeof val === 'boolean') return val ? 'on' : 'off';
      if (val === null || val === undefined || val === '') return '(empty)';
      return String(val);
    }

    function cloneSettingGlobal(key) {
      const val = settingsSchema.value?.globals?.[key];
      if (key === 'BLOCKED_TYPES') return Array.isArray(val) ? [...val] : [];
      if (typeof val === 'boolean') return val;
      if (val === null || val === undefined) return '';
      return val;
    }

    function initCompSettingsFromConfig(overrides) {
      if (!settingsSchema.value) return;
      for (const group of settingsSchema.value.groups || []) {
        for (const key of group.keys || []) {
          const inherited = !(key in (overrides || {}));
          compSettingsInherited[key] = inherited;
          if (inherited) {
            compSettings[key] = cloneSettingGlobal(key);
          } else {
            const raw = overrides[key];
            if (key === 'BLOCKED_TYPES') {
              compSettings[key] = Array.isArray(raw) ? [...raw] : [];
            } else if (typeof settingsSchema.value.globals?.[key] === 'boolean') {
              compSettings[key] = !!raw;
            } else {
              compSettings[key] = raw;
            }
          }
        }
      }
    }

    function onCompSettingInheritChange(key) {
      if (compSettingsInherited[key]) {
        compSettings[key] = cloneSettingGlobal(key);
      }
    }

    function toggleCompSettingSet(key, type) {
      if (!Array.isArray(compSettings[key])) compSettings[key] = [];
      const idx = compSettings[key].indexOf(type);
      if (idx === -1) compSettings[key].push(type);
      else compSettings[key].splice(idx, 1);
    }

    function buildCompSettingsPayload() {
      const settings = {};
      if (!settingsSchema.value) return settings;
      for (const group of settingsSchema.value.groups || []) {
        for (const key of group.keys || []) {
          if (compSettingsInherited[key]) continue;
          const val = compSettings[key];
          if (key === 'BLOCKED_TYPES') {
            settings[key] = Array.isArray(val) ? [...val].sort() : [];
          } else {
            settings[key] = val;
          }
        }
      }
      return settings;
    }

    async function loadSettingsSchema() {
      try {
        settingsSchema.value = await api('/api/settings-schema');
      } catch { /* ignore */ }
    }

    function submissionConfigComplete(sub) {
      if (!sub || typeof sub !== 'object') return false;
      const transport = (sub.transport || 'ui').toLowerCase();
      if (transport === 'api' || transport === 'api_multipart') {
        return !!(sub.api_url || sub.start_url);
      }
      if (transport === 'api_document') {
        return !!(sub.upload_url && sub.api_url);
      }
      const hasFile = (sub.inputs || []).some(i => i.type === 'file' || i.path_from === 'payload');
      if (hasFile) {
        return !!(sub.start_url && sub.submit_selector && sub.inputs?.length);
      }
      return !!(sub.start_url && sub.submit_selector && (sub.inputs?.length || sub.input_selector));
    }

    function applySubmissionToCompCfg(sub) {
      const s = sub || {};
      const t = (s.transport || 'ui').toLowerCase();
      compCfg.submission.transport = ['api', 'api_document', 'api_multipart'].includes(t) ? t : 'ui';
      compCfg.submission.start_url = s.start_url || '';
      compCfg.submission.submit_selector = s.submit_selector || '';
      compCfg.submission.response_selector = s.response_selector || '';
      compCfg.submission.response_within_selector = s.response_within_selector || '';
      compCfg.submission.response_text_within_selector = s.response_text_within_selector || '';
      compCfg.submission.submit_via = s.submit_via || 'click';
      compCfg.submission.response_wait_ms = s.response_wait_ms ?? 5000;
      compCfg.submission.inputs = (s.inputs || []).map(inp => ({ ...inp }));
      compCfg.submission.api_url = s.api_url || '';
      compCfg.submission.api_method = s.api_method || 'POST';
      compCfg.submission.api_response_path = s.api_response_path || 'response';
      compCfg.submission.api_body_json = JSON.stringify(s.api_body || { prompt: '{{prompt}}' }, null, 2);
      compCfg.submission.api_headers_json = JSON.stringify(s.api_headers || {}, null, 2);
      compCfg.submission.upload_url = s.upload_url || '';
      compCfg.submission.upload_file_field = s.upload_file_field || 'file';
      compCfg.submission.upload_response_path = s.upload_response_path || 'document_id';
      compCfg.submission.multipart_prompt_field = s.multipart_prompt_field || 'prompt';
      compCfg.submission.multipart_file_field = s.multipart_file_field || 'file';
      if (['api', 'api_document', 'api_multipart'].includes(compCfg.submission.transport)) {
        discoverTransport.value = 'api';
        apiDiscover.transport = compCfg.submission.transport;
        apiDiscover.url = compCfg.submission.api_url;
        apiDiscover.uploadUrl = compCfg.submission.upload_url;
        apiDiscover.method = compCfg.submission.api_method;
        apiDiscover.responsePath = compCfg.submission.api_response_path;
        apiDiscover.bodyJson = compCfg.submission.api_body_json;
        apiDiscover.headersJson = compCfg.submission.api_headers_json;
      }
    }

    function buildSubmissionPayload() {
      const transport = compCfg.submission.transport || 'ui';
      if (transport === 'api_document') {
        let api_body = { prompt: '{{prompt}}', document_id: '{{document_id}}', context_from: 'upload' };
        let api_headers = {};
        try { api_body = JSON.parse(compCfg.submission.api_body_json || '{}'); } catch { /* keep default */ }
        try { api_headers = JSON.parse(compCfg.submission.api_headers_json || '{}'); } catch { /* ignore */ }
        return {
          transport: 'api_document',
          upload_url: compCfg.submission.upload_url,
          upload_file_field: compCfg.submission.upload_file_field || 'file',
          upload_response_path: compCfg.submission.upload_response_path || 'document_id',
          api_url: compCfg.submission.api_url,
          api_method: compCfg.submission.api_method || 'POST',
          api_headers,
          api_body,
          api_response_path: compCfg.submission.api_response_path || 'response',
        };
      }
      if (transport === 'api_multipart') {
        return {
          transport: 'api_multipart',
          api_url: compCfg.submission.api_url,
          multipart_prompt_field: compCfg.submission.multipart_prompt_field || 'prompt',
          multipart_file_field: compCfg.submission.multipart_file_field || 'file',
          api_response_path: compCfg.submission.api_response_path || 'response',
        };
      }
      if (transport === 'api') {
        let api_body = { prompt: '{{prompt}}' };
        let api_headers = {};
        try { api_body = JSON.parse(compCfg.submission.api_body_json || '{}'); } catch { /* keep default */ }
        try { api_headers = JSON.parse(compCfg.submission.api_headers_json || '{}'); } catch { /* ignore */ }
        return {
          transport: 'api',
          api_url: compCfg.submission.api_url,
          api_method: compCfg.submission.api_method || 'POST',
          api_headers,
          api_body,
          api_response_path: compCfg.submission.api_response_path || 'response',
        };
      }
      return {
        transport: 'ui',
        start_url: compCfg.submission.start_url,
        inputs: compCfg.submission.inputs.map(i => ({ ...i })),
        submit_selector: compCfg.submission.submit_selector,
        response_selector: compCfg.submission.response_selector,
        response_within_selector: compCfg.submission.response_within_selector || '',
        response_text_within_selector: compCfg.submission.response_text_within_selector || '',
        submit_via: compCfg.submission.submit_via,
        response_wait_ms: Number(compCfg.submission.response_wait_ms),
      };
    }

    async function loadCompCfg() {
      if (!site.value || !component.value) return;
      compCfgError.value = '';
      try {
        await loadSettingsSchema();
        const data = await api(`/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`);
        compCfg.login_url = data.login_url || '';
        applySubmissionToCompCfg(data.submission);
        compCfgEmpty.value = !submissionConfigComplete(data.submission);
        initCompSettingsFromConfig(data.settings || {});
      } catch (e) { compCfgError.value = String(e); }
    }

    async function saveCompCfg() {
      compCfgError.value = '';
      compCfgSaved.value = false;
      try {
        const existing = await api(`/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`);
        const payload = {
          ...existing,
          login_url: compCfg.login_url,
          submission: buildSubmissionPayload(),
        };
        const settings = buildCompSettingsPayload();
        if (Object.keys(settings).length) payload.settings = settings;
        else delete payload.settings;
        await api(`/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: payload }),
        });
        compCfgSaved.value = true;
        setTimeout(() => { compCfgSaved.value = false; }, 3000);
        await loadContext();
      } catch (e) { compCfgError.value = String(e); }
    }

    function addInput() {
      compCfg.submission.inputs.push({ selector: '', type: 'text' });
    }
    function removeInput(i) {
      compCfg.submission.inputs.splice(i, 1);
    }

    const cfg = reactive({});
    const cfgSaved = ref(false);
    const cfgError = ref('');
    const BLOCKED_OPTIONS = ['image', 'font', 'media', 'stylesheet'];
    const COUNTRIES = ['US', 'UK', 'DE', 'FR', 'JP', 'CA', 'AU', 'NL', 'ES', 'IT'];
    const CHANNELS = ['chromium', 'chrome', 'chrome-beta', 'msedge'];
    const FETCH_METHODS = ['auto', 'pool', 'cluster', 'human'];

    async function loadConfig() {
      try {
        const data = await api('/api/config');
        Object.assign(cfg, data);
        // Ensure BLOCKED_TYPES is always an array for checkbox binding
        if (!Array.isArray(cfg.BLOCKED_TYPES)) cfg.BLOCKED_TYPES = [];
      } catch (e) {
        cfgError.value = String(e);
      }
    }

    async function saveConfig() {
      cfgError.value = '';
      cfgSaved.value = false;
      try {
        await api('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes: { ...cfg } }),
        });
        cfgSaved.value = true;
        setTimeout(() => { cfgSaved.value = false; }, 3000);
      } catch (e) {
        cfgError.value = String(e);
      }
    }

    function toggleBlocked(type) {
      const idx = cfg.BLOCKED_TYPES.indexOf(type);
      if (idx === -1) cfg.BLOCKED_TYPES.push(type);
      else cfg.BLOCKED_TYPES.splice(idx, 1);
    }

    // --- Startup modal ---
    const showModal = ref(false);
    const modalSite = ref('');
    const modalComponent = ref('');
    const modalComponents = ref([]);
    const modalNewSite = ref('');
    const modalNewComponent = ref('');
    const modalRenameSite = ref('');
    const modalRenameComponent = ref('');
    const modalError = ref('');
    const modalMsg = ref('');

    async function onModalSiteChange() {
      modalComponent.value = '';
      modalComponents.value = [];
      modalNewSite.value = '';
      modalNewComponent.value = '';
      modalRenameSite.value = modalSite.value || '';
      modalRenameComponent.value = '';
      if (modalSite.value) {
        modalComponents.value = await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components`);
      }
    }

    function onModalComponentChange() {
      modalRenameComponent.value = modalComponent.value || '';
    }

    async function modalCreateSite() {
      modalError.value = '';
      modalMsg.value = '';
      const domain = modalNewSite.value.trim();
      if (!domain) { modalError.value = 'Enter a domain.'; return; }
      try {
        const created = await api('/api/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        await loadSites();
        modalSite.value = created.domain;
        modalRenameSite.value = created.domain;
        modalNewSite.value = '';
        modalComponent.value = '';
        modalRenameComponent.value = '';
        modalComponents.value = await api(`/api/sites/${encodeURIComponent(created.domain)}/components`);
        modalMsg.value = 'Site created';
      } catch (e) {
        modalError.value = 'Create site failed: ' + e.message;
      }
    }

    async function modalRenameSiteAction() {
      modalError.value = '';
      modalMsg.value = '';
      const current = modalSite.value;
      const next = modalRenameSite.value.trim();
      if (!current || !next || current === next) return;
      try {
        const renamed = await api(`/api/sites/${encodeURIComponent(current)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: next }),
        });
        if (site.value === current) site.value = renamed.domain;
        await loadSites();
        modalSite.value = renamed.domain;
        modalRenameSite.value = renamed.domain;
        modalComponents.value = await api(`/api/sites/${encodeURIComponent(renamed.domain)}/components`);
        components.value = site.value === renamed.domain ? [...modalComponents.value] : components.value;
        modalMsg.value = 'Site renamed';
      } catch (e) {
        modalError.value = 'Rename site failed: ' + e.message;
      }
    }

    async function modalDeleteSite() {
      modalError.value = '';
      modalMsg.value = '';
      if (!modalSite.value) return;
      if (!confirm(`Delete site "${modalSite.value}" and all components?`)) return;
      const deleting = modalSite.value;
      try {
        await api(`/api/sites/${encodeURIComponent(deleting)}`, { method: 'DELETE' });
        if (site.value === deleting) {
          site.value = '';
          component.value = '';
          components.value = [];
        }
        await loadSites();
        modalSite.value = '';
        modalRenameSite.value = '';
        modalComponent.value = '';
        modalRenameComponent.value = '';
        modalComponents.value = [];
        modalMsg.value = 'Site deleted';
      } catch (e) {
        modalError.value = 'Delete site failed: ' + e.message;
      }
    }

    async function modalCreateComponent() {
      modalError.value = '';
      modalMsg.value = '';
      if (!modalSite.value) { modalError.value = 'Select a site first.'; return; }
      const name = modalNewComponent.value.trim();
      if (!name) { modalError.value = 'Enter a component name.'; return; }
      try {
        const created = await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        modalComponents.value = await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components`);
        if (site.value === modalSite.value) components.value = [...modalComponents.value];
        modalComponent.value = created.name;
        modalRenameComponent.value = created.name;
        modalNewComponent.value = '';
        modalMsg.value = 'Component created';
      } catch (e) {
        modalError.value = 'Create component failed: ' + e.message;
      }
    }

    async function modalRenameComponentAction() {
      modalError.value = '';
      modalMsg.value = '';
      const current = modalComponent.value;
      const next = modalRenameComponent.value.trim();
      if (!modalSite.value || !current || !next || current === next) return;
      try {
        const renamed = await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components/${encodeURIComponent(current)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next }),
        });
        if (site.value === modalSite.value && component.value === current) component.value = renamed.name;
        modalComponents.value = await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components`);
        if (site.value === modalSite.value) components.value = [...modalComponents.value];
        modalComponent.value = renamed.name;
        modalRenameComponent.value = renamed.name;
        modalMsg.value = 'Component renamed';
      } catch (e) {
        modalError.value = 'Rename component failed: ' + e.message;
      }
    }

    async function modalDeleteComponent() {
      modalError.value = '';
      modalMsg.value = '';
      if (!modalSite.value || !modalComponent.value) return;
      if (!confirm(`Delete component "${modalComponent.value}"?`)) return;
      const deleting = modalComponent.value;
      try {
        await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components/${encodeURIComponent(deleting)}`, { method: 'DELETE' });
        if (site.value === modalSite.value && component.value === deleting) component.value = '';
        modalComponents.value = await api(`/api/sites/${encodeURIComponent(modalSite.value)}/components`);
        if (site.value === modalSite.value) components.value = [...modalComponents.value];
        modalComponent.value = '';
        modalRenameComponent.value = '';
        modalMsg.value = 'Component deleted';
      } catch (e) {
        modalError.value = 'Delete component failed: ' + e.message;
      }
    }

    async function confirmModal() {
      modalError.value = '';
      let s = modalSite.value, c = modalComponent.value;
      if (!s) { modalError.value = 'Select or create a site.'; return; }
      if (!c) { modalError.value = 'Select or create a component.'; return; }
      site.value = s;
      components.value = await api(`/api/sites/${encodeURIComponent(s)}/components`);
      component.value = c;
      await loadContext();
      showModal.value = false;
      await checkSetupAndNavigate();
    }

    // --- Onboarding hints ---
    const HINTS = {
      generate: {
        title: 'Generate Tests',
        text: 'Craft exploit test cases for AI bug bounty programs. Choose a playbook and strategy - Multimodal covers file-upload vectors (PDF, OCR, CSV, audio) mapped to frameworks like OWASP LLM. Other strategies are text-first. Saved tests land in the component tests/ directory when site and component are set.',
      },
      payloads: {
        title: 'Payload Workshop',
        text: 'Build multimodal attack artifacts (hidden PDF text, OCR images, CSV injection, audio TTS) for bounty submissions. Generate here before Run Tests, or attach paths to prompts in Test Management.',
      },
      discover: {
        title: 'Connect Target',
        text: 'Map the target LLM surface before hunting. Step 1: public access or saved login. Step 2: optional company context. Step 3: connect via browser UI - Start Discovery scans uploads and writes multimodal inputs into config.yaml - or API endpoint discovery when the app exposes a chat API (e.g. POST /api/chat). Both paths write config.yaml for Run Tests.',
      },
      run: {
        title: 'Run Tests',
        text: 'Execute test prompts against the target and capture evidence for bounty reports. Select a strategy and playbook, then Run. Results appear in the table below and are saved to a timestamped log directory. Job output streams in the Experiment Output panel.',
      },
      tests: {
        title: 'Test Management',
        text: 'Open a generated test file by strategy, then edit categories and prompts in place - add rows, refine wording, or remove items. Save writes changes back to the component tests/ directory for the next hunt.',
      },
      risk: {
        title: 'Finding Assessment',
        text: 'Triage findings by severity before submission. Each compliance log is judged by AI (indeterminate → informational → low → medium → high → critical). Assess one log or batch-assess logs from the last hour, 4 hours, or 24 hours. Results are saved as pipeline_report.json beside each attack log.',
      },
      export: {
        title: 'Submit Findings to Genbounty',
        text: 'Configure export settings (risk levels, auto-submit after assessment) and save to this component\'s config.yaml. Settings apply when you submit manually or when assessment runs from Run Tests or Finding Assessment. Credentials stay in .env.',
      },
      cache: {
        title: 'Clear Cache',
        text: 'Global default for Gemini context cache (stored in .env). Per-component overrides in config.yaml → settings take precedence. Clear All Caches removes Gemini handles, on-disk assessment results ([cache hit]), and __pycache__ folders.',
      },
      component: {
        title: 'Component Config',
        text: 'Configure how browser-bot interacts with this component\'s UI - page URL, input selector, submit button, and response container. Settings overrides mirror Browser Config and Cache Control; omitted keys inherit via site config, global config.py/.env, then config.defaults.yaml.',
      },
      config: {
        title: 'Global Config',
        text: 'Controls browser-bot\'s global behaviour. Changes are written directly to config.py and override config.defaults.yaml. Per-site or per-component overrides in config.yaml → settings take precedence on the next run.',
      },
    };

    const _legacyHints = JSON.parse(localStorage.getItem('airta_hints_dismissed') || '{}');
    const _storedHints = JSON.parse(localStorage.getItem('genbounty_hints_dismissed') || '{}');
    const hintDismissed = ref({ ..._legacyHints, ..._storedHints });

    function dismissHint(key) {
      hintDismissed.value = { ...hintDismissed.value, [key]: true };
      localStorage.setItem('genbounty_hints_dismissed', JSON.stringify(hintDismissed.value));
    }

    const runResults = ref([]);
    const runResultsLoading = ref(false);
    const expandedRunRows = ref({});

    async function loadLogs() {
      if (!site.value || !component.value) return;
      const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
      const l = await api(`/api/sites/${s}/${c}/logs`);
      logs.runs = l.runs;
      logs.attacks = l.attacks || [];
      logs.reports = l.reports;
    }

    async function loadLatestRunLog() {
      if (!site.value || !component.value) return;
      runResultsLoading.value = true;
      try {
        await loadLogs();
        if (!logs.runs.length) return;
        const data = await api(`/api/files?path=${encodeURIComponent(logs.runs[0].path)}`);
        expandedRunRows.value = {};
        if (data.mode === 'multi') {
          runResults.value = (data.batches || []).flatMap(b =>
            (b.turns || []).map((t, ti) => ({
              label: `Batch ${b.batch_index + 1} / Turn ${ti + 1}`,
              input: t.input, response: t.response,
            }))
          );
        } else {
          runResults.value = (data.entries || []).map((e, i) => ({
            label: `#${i + 1}`, input: e.input, response: e.response,
          }));
        }
      } catch (e) { console.error(e); }
      finally { runResultsLoading.value = false; }
    }

    function toggleRunRow(i) {
      expandedRunRows.value = { ...expandedRunRows.value, [i]: !expandedRunRows.value[i] };
    }

    const activeJobs = reactive({});
    const sseConnections = {};
    const runProgress = ref(null);
    const runPreviewBySlot = ref({});
    const runPreviewConfig = ref({ mode: 'human', slotCount: 1 });
    const runLivePanelOpen = ref(true);
    const runPreviewModalSlot = ref(0);
    const showRunPreviewModal = ref(false);
    const runPreviewModalUrl = ref('');
    const runPreviewModalLabel = ref('');
    const showRunLoginModal = ref(false);
    const showRunRateLimitModal = ref(false);
    const showRunCloudflareModal = ref(false);
    const pendingRunAfterCloudflare = ref(false);
    const runCloudflareStopIssued = ref(false);
    const runCloudflareModalShown = ref(false);
    const runCloudflareTestsStopped = ref(false);
    const runCloudflareSaving = ref(false);
    const runCloudflareError = ref('');
    const runCloudflareSettings = reactive({
      FETCH_METHOD: 'human',
      HEADLESS: false,
      cloudflare_headed: true,
    });
    const cloudflareModalNeedsSettings = computed(() => {
      return !!runBlockedInfo.value?.needs_headed_browser;
    });
    const cloudflareModalTimedOut = computed(() => {
      const p = runBlockedInfo.value;
      return !!(p?.stop_run && p?.kind === 'cloudflare' && !p?.needs_headed_browser);
    });
    const runRateLimitBackoffSec = ref(60);
    const rateLimitCountdown = ref(0);
    const rateLimitWaiting = ref(false);
    const pendingRunAfterRateLimit = ref(false);
    let rateLimitTimer = null;
    const runLoginUrl = ref('');
    const runBlockedInfo = ref(null);
    const pendingRunAfterLogin = ref(false);
    const authSaving = ref(false);
    const authSaveError = ref('');

    function previewUrlFor(jobId, slot) {
      return `${API}/api/jobs/${jobId}/preview/${slot}?t=${Date.now()}`;
    }

    async function resolveRunPreviewConfig() {
      let method = 'human';
      let poolSize = 8;
      let contextCount = 8;
      let pagesPerContext = 6;
      try {
        if (site.value && component.value) {
          const eff = await api(
            `/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/effective-settings`
          );
          const pick = (key) => {
            const row = eff?.[key];
            if (row && row.effective !== undefined && row.effective !== null && row.effective !== '') {
              return row.effective;
            }
            return row?.global;
          };
          method = String(pick('FETCH_METHOD') || 'human').toLowerCase();
          poolSize = Number(pick('POOL_SIZE')) || 8;
          contextCount = Number(pick('CONTEXT_COUNT')) || 8;
          pagesPerContext = Number(pick('PAGES_PER_CONTEXT')) || 6;
        } else {
          await loadConfig();
          method = String(cfg.FETCH_METHOD || 'human').toLowerCase();
          poolSize = Number(cfg.POOL_SIZE) || 8;
          contextCount = Number(cfg.CONTEXT_COUNT) || 8;
          pagesPerContext = Number(cfg.PAGES_PER_CONTEXT) || 6;
        }
      } catch {
        method = 'human';
      }

      if (method === 'human') {
        return { mode: 'human', slotCount: 1 };
      }
      if (method === 'pool') {
        return { mode: 'parallel', slotCount: Math.max(1, Math.min(32, poolSize)) };
      }
      if (method === 'cluster') {
        return { mode: 'parallel', slotCount: Math.max(1, contextCount * pagesPerContext) };
      }
      const pool = Math.max(1, poolSize);
      const cluster = Math.max(1, contextCount * pagesPerContext);
      return { mode: 'parallel', slotCount: Math.max(pool, cluster) };
    }

    async function initRunPreviewConfig() {
      runPreviewConfig.value = await resolveRunPreviewConfig();
    }

    function previewForSlot(slot) {
      return runPreviewBySlot.value[slot] || null;
    }

    const runPreviewSlotIndices = computed(() => {
      const n = runPreviewConfig.value.slotCount || 1;
      return Array.from({ length: n }, (_, i) => i);
    });

    const hasRunLivePreview = computed(() => Object.keys(runPreviewBySlot.value).length > 0);

    const runLivePanelVisible = computed(() => {
      if (activeJobs.run_tests) return true;
      return hasRunLivePreview.value;
    });

    function updateRunPreview(jobId, slot = 0) {
      if (!jobId) return;
      const s = Number(slot) || 0;
      const url = previewUrlFor(jobId, s);
      const { mode } = runPreviewConfig.value;

      if (mode === 'human') {
        runPreviewBySlot.value = { 0: { slot: 0, url, label: 'Browser' } };
      } else {
        const label = `Worker ${s + 1}`;
        runPreviewBySlot.value = {
          ...runPreviewBySlot.value,
          [s]: { slot: s, url, label },
        };
      }

      if (showRunPreviewModal.value) {
        const modalSlot = runPreviewModalSlot.value;
        if (mode === 'human' || modalSlot === s) {
          runPreviewModalUrl.value = url;
        }
      }
    }

    function clearRunPreviews() {
      runPreviewBySlot.value = {};
      closeRunPreviewModal();
    }

    function openRunPreviewModal(preview, slot = null) {
      if (!preview) return;
      runPreviewModalUrl.value = preview.url;
      runPreviewModalLabel.value = preview.label;
      runPreviewModalSlot.value = slot ?? preview.slot ?? 0;
      showRunPreviewModal.value = true;
    }

    function closeRunPreviewModal() {
      showRunPreviewModal.value = false;
      runPreviewModalUrl.value = '';
      runPreviewModalLabel.value = '';
    }

    function formatRunEta(sec) {
      if (sec == null || sec === '' || Number.isNaN(Number(sec))) return '-';
      const n = Number(sec);
      if (n <= 0) return '~0s';
      if (n < 90) return `~${Math.round(n)}s`;
      const m = Math.floor(n / 60);
      const s = Math.round(n % 60);
      return `~${m}m ${s}s`;
    }

    const runProgressBarLabel = computed(() => {
      const p = runProgress.value;
      if (!p) return '';
      if (p.type === 'batch_start') return 'Batch assessment…';
      if (p.type === 'batch_progress') {
        const cur = p.current || 0;
        const total = p.total || 0;
        return total ? `Assessing log ${cur}/${total}…` : 'Batch assessment…';
      }
      if (p.type === 'batch_done') return 'Batch assessment complete';
      if (p.phase === 'risk' || p.type === 'risk_start' || p.type === 'risk_progress' || p.type === 'risk_done') {
        if (p.type === 'risk_start') return 'Risk assessment…';
        if (p.type === 'risk_done') return 'Risk assessment complete';
        return `Risk assessment · ${p.current ?? 0} / ${p.total ?? 0} entries`;
      }
      if (p.type === 'suite') {
        return `Strategy ${p.current} / ${p.total}${p.strategy ? ' · ' + p.strategy : ''}`;
      }
      if (p.type === 'run_start') return 'Starting tests…';
      if (p.type === 'run_done') return 'Tests complete';
      if (p.type === 'blocked') return p.message || 'Tests paused';
      if (p.type === 'resilience') return p.message || 'Resilience attempt';
      return `${p.mode === 'multi' ? 'Multi-turn' : 'Single'} · ${p.current ?? 0} / ${p.total ?? 0} prompts`;
    });

    const runProgressEtaText = computed(() => {
      const p = runProgress.value;
      if (!p) return '';
      if (p.type === 'risk_start') return 'Estimating…';
      if (p.phase === 'risk' || p.type === 'risk_progress' || p.type === 'risk_done') {
        if (p.type === 'risk_done') return `${formatRunEta(p.elapsed_sec)} total`;
        if (p.eta_sec != null && p.eta_sec !== '') return `ETA ${formatRunEta(p.eta_sec)} · ${formatRunEta(p.elapsed_sec)} elapsed`;
        return '-';
      }
      if (p.type === 'run_start' || p.type === 'suite') return 'Estimating…';
      if (p.type === 'run_done') return `${formatRunEta(p.elapsed_sec)} total`;
      if (p.eta_sec != null && p.eta_sec !== '') return `ETA ${formatRunEta(p.eta_sec)} · ${formatRunEta(p.elapsed_sec)} elapsed`;
      return '-';
    });

    /** Risk tab: standalone risk job, or run_tests job while in risk phase (e.g. after tests when “assess after” is on). */
    const riskTabProgressBarVisible = computed(() => {
      const p = runProgress.value;
      if (!p) return false;
      if (activeJobs.security_assess) return true;
      return !!(p.phase === 'risk' && activeJobs.run_tests);
    });

    function pretty(slug) {
      const short = new Set(['eu','ai','uk','us','oecd','gdpr','iso']);
      return (slug || '').replace(/_/g, '-').split('-').filter(Boolean).map(p =>
        short.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)
      ).join(' ');
    }

    function lineClass(line) {
      const t = line.trimStart();
      if (t.startsWith('[resilience]') || t.startsWith('[evasion]')) return 'line-resilience';
      if (line.startsWith('[+]') || line.startsWith('[*]')) return 'line-ok';
      if (line.startsWith('[!]') || line.startsWith('[-]') || line.startsWith('[error]')) return 'line-err';
      if (line.startsWith('  ')) return 'line-info';
      return '';
    }

    async function loadSites() {
      sites.value = await api('/api/sites');
      allStrategies.value = await api('/api/strategies');
      allPlaybooks.value = await api('/api/playbooks');
    }

    /** Apply TARGET/COMPONENT from .env (server normalizes URLs to site ids). Returns true if selected. */
    async function applyEnvDefaults() {
      const defaults = await api('/api/env-defaults');
      const target = (defaults.target || '').trim();
      if (!target || !sites.value.includes(target)) return false;

      const comps = await api(`/api/sites/${encodeURIComponent(target)}/components`);
      let comp = (defaults.component || '').trim();
      if (comp && !comps.includes(comp)) return false;
      if (!comp) {
        if (comps.length === 1) comp = comps[0];
        else return false;
      }

      site.value = target;
      components.value = comps;
      component.value = comp;
      await loadContext();
      await checkSetupAndNavigate();
      return true;
    }

    async function onSiteChange() {
      component.value = '';
      loginUrl.value = '';
      authConfigured.value = false;
      if (site.value) {
        components.value = await api(`/api/sites/${encodeURIComponent(site.value)}/components`);
        await loadAuthStatus();
      } else {
        components.value = [];
      }
    }

    async function loadContext() {
      if (site.value && component.value) {
        const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
        runStrategies.value = await api(`/api/sites/${s}/${c}/strategies`);
        await loadLogs();
        if (tab.value === 'export' || tab.value === 'risk') await loadExportSettings();
        if (tab.value === 'settings' && settingsTab.value === 'component') loadCompCfg();
        if (tab.value === 'tests') await tmLoadStrategies();
      }
    }

    async function loadRunPlaybooks() {
      runPlaybooks.value = [];
      runAllPlaybooks.value = [];
      run.playbook = '';
      runArtifactStatus.value = [];
      runUploadWarning.value = '';
      if (!run.strategy || !site.value || !component.value) return;
      const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
      if (run.strategy === '__all__') {
        runAllPlaybooks.value = await api(`/api/sites/${s}/${c}/all-playbooks`);
      } else {
        runPlaybooks.value = await api(`/api/sites/${s}/${c}/strategies/${encodeURIComponent(run.strategy)}/playbooks`);
      }
    }

    async function loadRunArtifactStatus() {
      runArtifactStatus.value = [];
      runUploadWarning.value = '';
      if (run.strategy !== 'multimodal' || !run.playbook || run.strategy === '__all__') return;
      const suitePath = run.playbook;
      if (!suitePath || !suitePath.endsWith('.json')) return;
      try {
        const res = await api(`/api/payloads/artifact-status?suite_path=${encodeURIComponent(suitePath)}`);
        runArtifactStatus.value = res.prompts || [];
        if (runArtifactStatus.value.length) {
          const cfg = await api(`/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`);
          const sub = cfg?.submission || {};
          const transport = (sub.transport || 'ui').toLowerCase();
          let uploadOk = transport === 'api_document' || transport === 'api_multipart';
          if (!uploadOk && transport === 'ui') {
            uploadOk = (sub.inputs || []).some(i => i.type === 'file' || i.path_from === 'payload');
          }
          if (!uploadOk) {
            runUploadWarning.value = 'Component config lacks file upload support. Configure a file input or api_document transport in Settings.';
          }
        }
      } catch (_) {
        runArtifactStatus.value = [];
      }
    }

    watch(() => run.playbook, () => { loadRunArtifactStatus(); });

    watch(() => gen.strategy, (strategy) => {
      if (gen.strategy === '__all__') return;
      const suggested = STRATEGY_DEFAULT_PLAYBOOK[strategy];
      if (suggested && allPlaybooks.value.includes(suggested)) {
        gen.playbook = suggested;
      }
    });

    async function refreshRunTests() {
      if (!site.value || !component.value) return;
      const s = encodeURIComponent(site.value), c = encodeURIComponent(component.value);
      const prevStrategy = run.strategy;
      runStrategies.value = await api(`/api/sites/${s}/${c}/strategies`);
      // Keep current strategy selection if it still exists after refresh
      if (prevStrategy && runStrategies.value.some(x => x.slug === prevStrategy)) {
        run.strategy = prevStrategy;
        await loadRunPlaybooks();
      } else {
        run.strategy = '';
        run.playbook = '';
        runPlaybooks.value = [];
        runAllPlaybooks.value = [];
      }
    }

    // Lines to suppress in the run_tests console - individual prompt/response
    // entries are shown in the results table instead.
    function _isRunDetailLine(line) {
      const t = line.trimStart();
      return t.startsWith('Input: ') || t.startsWith('Response: ') || t.startsWith('Response:None');
    }

    function _isProgressMetaLine(line) {
      return line.trimStart().startsWith('[airta_progress]');
    }

    function activeOutput(type) {
      const jid = activeJobs[type];
      if (!jid) return [];
      const j = jobs.value.find(x => x.id === jid);
      if (!j) return [];
      const lines = j._output || [];
      if (type === 'run_tests' || type === 'security_assess') {
        return lines.filter(l => !_isRunDetailLine(l) && !_isProgressMetaLine(l));
      }
      return lines;
    }

    const panelOutput = computed(() => {
      const t = tab.value;
      if (t === 'generate') return activeOutput('generate');
      if (t === 'discover') {
        for (const key of ['discover', 'manual_discover', 'api_discover', 'login']) {
          const lines = activeOutput(key);
          if (lines.length) return lines;
        }
        return [];
      }
      if (t === 'run') {
        const runLines = activeOutput('run_tests');
        if (runLines.length) return runLines;
        return activeOutput('sample_request');
      }
      if (t === 'risk') return activeOutput('security_assess');
      if (t === 'export') return activeOutput('export');
      if (t === 'settings' && settingsTab.value === 'cache') return activeOutput('clear_cache');
      return [];
    });

    function connectSSE(jobId) {
      if (sseConnections[jobId]) return;
      const j = jobs.value.find(x => x.id === jobId);
      if (!j) return;
      if (!j._output) j._output = [];
      const src = new EventSource(`${API}/api/jobs/${jobId}/stream`);
      sseConnections[jobId] = src;
      src.onmessage = (e) => {
        const line = e.data;
        if (line.startsWith('[airta_progress] ')) {
          try {
            const p = JSON.parse(line.slice('[airta_progress] '.length));
            const isRunJob = j.type === 'run_tests' && activeJobs.run_tests === j.id;
            const isRiskJob = j.type === 'security_assess' && activeJobs.security_assess === j.id;
            if (p.type === 'screenshot') {
              if (isRunJob) updateRunPreview(jobId, p.slot ?? 0);
            } else if (isRunJob || isRiskJob) {
              if (p.type === 'cloudflare_wait' && isRunJob) {
                runBlockedInfo.value = { ...runBlockedInfo.value, ...p, kind: 'cloudflare' };
                if (!runCloudflareModalShown.value) {
                  runCloudflareModalShown.value = true;
                  pendingRunAfterCloudflare.value = true;
                  tab.value = 'run';
                  showRunCloudflareModal.value = true;
                }
                runProgress.value = {
                  ...runProgress.value,
                  phase: 'blocked',
                  remaining_sec: p.remaining_sec,
                  pct: runProgress.value?.pct ?? 0,
                };
              } else if (p.type === 'blocked' && isRunJob) {
                runBlockedInfo.value = p;
                if (p.kind === 'login_required' || p.action === 'prompt_login' || p.action === 'start_login') {
                  pendingRunAfterLogin.value = true;
                  runLoginUrl.value = p.login_url || loginUrl.value || '';
                  tab.value = 'run';
                  showRunLoginModal.value = true;
                } else if (p.kind === 'rate_limited' || p.action === 'prompt_rate_limit') {
                  pendingRunAfterRateLimit.value = true;
                  runRateLimitBackoffSec.value = Math.max(1, Math.round(Number(p.backoff_sec) || 60));
                  tab.value = 'run';
                  showRunRateLimitModal.value = true;
                } else if (p.kind === 'cloudflare' || p.action === 'prompt_cloudflare') {
                  handleRunCloudflareBlocked(p);
                }
                runProgress.value = { ...p, pct: runProgress.value?.pct ?? 0, phase: 'blocked' };
              } else {
              let pct = 0;
              let phase = p.phase || 'submit';
              if (p.type === 'suite') {
                const total = p.total || 0;
                const cur = p.current || 0;
                pct = total ? Math.min(100, Math.round((cur / total) * 100)) : 0;
                phase = 'suite';
              } else if (p.type === 'run_start') {
                pct = 0;
                phase = 'submit';
              } else if (p.type === 'progress' && p.mode) {
                const total = p.total || 0;
                const cur = p.current || 0;
                pct = total ? Math.min(100, Math.round((cur / total) * 100)) : 0;
                phase = 'submit';
              } else if (p.type === 'run_done') {
                pct = 100;
                phase = 'submit';
                if (isRunJob) runLivePanelOpen.value = false;
              } else if (p.type === 'batch_start') {
                pct = 0;
                phase = 'risk';
              } else if (p.type === 'batch_progress') {
                const total = p.total || 0;
                const cur = p.current || 0;
                pct = total ? Math.min(100, Math.round((cur / total) * 100)) : 0;
                phase = 'risk';
              } else if (p.type === 'batch_done') {
                pct = 100;
                phase = 'risk';
              } else if (p.type === 'risk_start' || p.type === 'security_start') {
                pct = 0;
                phase = 'risk';
              } else if (p.type === 'risk_progress' || p.type === 'security_progress') {
                const total = p.total || 0;
                const cur = p.current || 0;
                pct = total ? Math.min(100, Math.round((cur / total) * 100)) : 0;
                phase = 'risk';
              } else if (p.type === 'risk_done' || p.type === 'security_done') {
                pct = 100;
                phase = 'risk';
              }
              runProgress.value = { ...p, pct, phase };
              }
            }
          } catch { /* ignore */ }
        }
        j._output.push(line);
        nextTick(() => {
          const el = document.querySelector('.output-panel .console');
          if (el) el.scrollTop = el.scrollHeight;
        });
      };
      src.addEventListener('done', (e) => {
        j.status = e.data || 'done';
        src.close();
        delete sseConnections[jobId];
        refreshJobs();
        if (j.type === 'run_tests') {
          runLivePanelOpen.value = false;
          loadLatestRunLog();
          setTimeout(() => {
            if (activeJobs.run_tests === j.id) {
              runProgress.value = null;
            }
          }, 5000);
        }
        if (j.type === 'security_assess') {
          loadLogs();
          setTimeout(() => {
            if (activeJobs.security_assess === j.id) runProgress.value = null;
          }, 5000);
        }
      });
      src.onerror = () => {
        src.close();
        delete sseConnections[jobId];
      };
    }

    async function refreshJobs() {
      const list = await api('/api/jobs');
      for (const j of list) {
        const existing = jobs.value.find(x => x.id === j.id);
        if (existing) {
          existing.status = j.status;
        } else {
          j._output = [];
          jobs.value.unshift(j);
        }
      }
    }

    async function startJob(type, params = {}) {
      const res = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, site: site.value, component: component.value, params })
      });
      res._output = [];
      jobs.value.unshift(res);
      activeJobs[type] = res.id;
      connectSSE(res.id);
      _schedulePoll();
      return res;
    }

    async function cancelJob(id) {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      refreshJobs();
    }

    const discoverJobId = ref(null);
    const discoverRunning = computed(() => {
      if (!discoverJobId.value) return false;
      const j = jobs.value.find(x => x.id === discoverJobId.value);
      return j && j.status === 'running';
    });
    const manualDiscoverJobId = ref(null);
    const manualDiscoverRunning = computed(() => {
      if (!manualDiscoverJobId.value) return false;
      const j = jobs.value.find(x => x.id === manualDiscoverJobId.value);
      return j && j.status === 'running';
    });

    const sampleRequestRunning = computed(() => {
      const jid = activeJobs.sample_request;
      if (!jid) return false;
      const j = jobs.value.find(x => x.id === jid);
      return j && (j.status === 'running' || j.status === 'pending');
    });

    const loginJobId = ref(null);
    const loginRunning = computed(() => {
      if (!loginJobId.value) return false;
      const j = jobs.value.find(x => x.id === loginJobId.value);
      return j && j.status === 'running';
    });
    const loginUrl = ref('');
    const authConfigured = ref(false);
    const authMode = ref(null);
    const authLoginChoice = ref(null);
    const authPublicSaving = ref(false);

    async function loadAuthStatus() {
      if (!site.value) {
        authConfigured.value = false;
        authMode.value = null;
        authLoginChoice.value = null;
        loginUrl.value = '';
        return;
      }
      const _isLocal = site.value.startsWith('localhost') || site.value.startsWith('127.') || site.value.startsWith('0.0.0.0');
      loginUrl.value = `${_isLocal ? 'http' : 'https'}://${site.value}`;
      try {
        const s = await api(`/api/sites/${encodeURIComponent(site.value)}/auth-status`);
        authConfigured.value = s.configured;
        authMode.value = s.mode || null;
        if (s.configured) {
          authLoginChoice.value = s.mode === 'none' ? false : true;
        } else {
          authLoginChoice.value = null;
        }
      } catch {
        authConfigured.value = false;
        authMode.value = null;
        authLoginChoice.value = null;
      }
    }

    function chooseAuthRequired() {
      authLoginChoice.value = true;
    }

    async function chooseAuthNotRequired() {
      if (!site.value || authPublicSaving.value) return;
      authPublicSaving.value = true;
      try {
        await api(`/api/sites/${encodeURIComponent(site.value)}/auth/public`, { method: 'POST' });
        await loadAuthStatus();
      } catch (e) {
        alert('Could not save public auth: ' + e.message);
      } finally {
        authPublicSaving.value = false;
      }
    }

    async function resetAuthSetup() {
      if (!site.value) return;
      try {
        await api(`/api/sites/${encodeURIComponent(site.value)}/auth`, { method: 'DELETE' });
      } catch {
        /* no auth file yet - still show choice */
      }
      authConfigured.value = false;
      authMode.value = null;
      authLoginChoice.value = null;
    }

    async function checkSetupAndNavigate() {
      if (!site.value || !component.value) return;
      await loadAuthStatus();
      try {
        const data = await api(`/api/sites/${encodeURIComponent(site.value)}/${encodeURIComponent(component.value)}/config`);
        if (!authConfigured.value || !data.submission) {
          tab.value = 'discover';
        }
      } catch { /* ignore */ }
    }

    async function onComponentChange() {
      await loadContext();
      await checkSetupAndNavigate();
    }

    async function startLogin(url) {
      const targetUrl = (typeof url === 'string' ? url : '') || loginUrl.value;
      if (!targetUrl || !site.value) return;
      const j = await startJob('login', { url: targetUrl });
      loginJobId.value = j.id;
    }

    async function prepareAuthForLoginCapture() {
      if (authMode.value === 'none') {
        await api(`/api/sites/${encodeURIComponent(site.value)}/auth`, { method: 'DELETE' });
        authConfigured.value = false;
        authMode.value = null;
      }
      authLoginChoice.value = true;
    }

    async function confirmRunLogin() {
      authSaveError.value = '';
      const url = runLoginUrl.value || loginUrl.value;
      if (!url) return;
      loginUrl.value = url;
      await prepareAuthForLoginCapture();
      await startLogin(url);
    }

    async function saveAuth() {
      if (!loginJobId.value || authSaving.value) return;
      authSaving.value = true;
      authSaveError.value = '';
      try {
        await api(`/api/jobs/${loginJobId.value}/stdin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '\n' })
        });
        await new Promise(r => setTimeout(r, 1200));
        await loadAuthStatus();
        if (authMode.value !== 'session') {
          authSaveError.value = 'Auth was not saved. Finish sign-in in the browser, then try again.';
          return;
        }
        if (pendingRunAfterLogin.value) {
          showRunLoginModal.value = false;
          runBlockedInfo.value = null;
          pendingRunAfterLogin.value = false;
          await startRunTests();
        }
      } catch (e) {
        authSaveError.value = e.message || 'Could not save auth.';
      } finally {
        authSaving.value = false;
      }
    }

    function dismissRunLoginModal() {
      showRunLoginModal.value = false;
    }

    function dismissRunRateLimitModal() {
      if (rateLimitWaiting.value) return;
      showRunRateLimitModal.value = false;
    }

    function resetRunCloudflareState() {
      runCloudflareStopIssued.value = false;
      runCloudflareModalShown.value = false;
      runCloudflareTestsStopped.value = false;
      runCloudflareSaving.value = false;
      runCloudflareError.value = '';
      runCloudflareSettings.FETCH_METHOD = 'human';
      runCloudflareSettings.HEADLESS = false;
      runCloudflareSettings.cloudflare_headed = true;
    }

    async function stopActiveRunTests(reason) {
      const jid = activeJobs.run_tests;
      if (!jid || runCloudflareStopIssued.value) return;
      runCloudflareStopIssued.value = true;
      runCloudflareTestsStopped.value = true;
      try {
        await cancelJob(jid);
      } catch (e) {
        runCloudflareError.value = reason || String(e);
      }
    }

    function handleRunCloudflareBlocked(p) {
      const needsSettings = !!p.needs_headed_browser;
      const shouldStop = needsSettings || !!(p.stop_run || p.fatal);
      tab.value = 'run';
      if (shouldStop) {
        void stopActiveRunTests(
          needsSettings
            ? 'Cloudflare requires headed human browser settings.'
            : 'Cloudflare verification did not complete in time.',
        );
      } else {
        pendingRunAfterCloudflare.value = true;
      }
      if (!runCloudflareModalShown.value) {
        runCloudflareModalShown.value = true;
        showRunCloudflareModal.value = true;
      }
    }

    function onCloudflareBackdropClick() {
      if (!cloudflareModalNeedsSettings.value) dismissRunCloudflareModal();
    }

    function dismissRunCloudflareModal() {
      showRunCloudflareModal.value = false;
      pendingRunAfterCloudflare.value = false;
    }

    async function cancelRunTestsFromCloudflare() {
      await stopActiveRunTests('Stopped from Cloudflare dialog.');
      dismissRunCloudflareModal();
    }

    async function rerunAfterCloudflareTimeout() {
      dismissRunCloudflareModal();
      resetRunCloudflareState();
      await startRunTests();
    }

    async function applyCloudflareSettingsAndRerun() {
      if (!site.value || !component.value) return;
      runCloudflareError.value = '';
      runCloudflareSaving.value = true;
      try {
        const s = encodeURIComponent(site.value);
        const c = encodeURIComponent(component.value);
        const existing = await api(`/api/sites/${s}/${c}/config`);
        const settings = { ...(existing.settings || {}), FETCH_METHOD: runCloudflareSettings.FETCH_METHOD };
        settings.HEADLESS = !!runCloudflareSettings.HEADLESS;
        const submission = { ...(existing.submission || {}) };
        if (runCloudflareSettings.cloudflare_headed) {
          submission.cloudflare_headed = true;
        } else {
          delete submission.cloudflare_headed;
        }
        await api(`/api/sites/${s}/${c}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: { ...existing, settings, submission } }),
        });
        dismissRunCloudflareModal();
        resetRunCloudflareState();
        await startRunTests();
      } catch (e) {
        runCloudflareError.value = String(e);
      } finally {
        runCloudflareSaving.value = false;
      }
    }

    function _clearRateLimitTimer() {
      if (rateLimitTimer) {
        clearInterval(rateLimitTimer);
        rateLimitTimer = null;
      }
    }

    async function confirmRateLimitResume() {
      if (rateLimitWaiting.value) return;
      const total = Math.max(1, Math.round(Number(runRateLimitBackoffSec.value) || 60));
      rateLimitWaiting.value = true;
      rateLimitCountdown.value = total;
      _clearRateLimitTimer();
      rateLimitTimer = setInterval(() => {
        rateLimitCountdown.value = Math.max(0, rateLimitCountdown.value - 1);
        if (rateLimitCountdown.value <= 0) _clearRateLimitTimer();
      }, 1000);
      await new Promise(r => setTimeout(r, total * 1000));
      _clearRateLimitTimer();
      rateLimitWaiting.value = false;
      showRunRateLimitModal.value = false;
      runBlockedInfo.value = null;
      const shouldResume = pendingRunAfterRateLimit.value;
      pendingRunAfterRateLimit.value = false;
      if (shouldResume) await startRunTests();
    }

    function onRunTroubleshoot() {
      if (runBlockedInfo.value?.kind === 'login_required') {
        showRunLoginModal.value = true;
        return;
      }
      if (runBlockedInfo.value?.kind === 'rate_limited') {
        showRunRateLimitModal.value = true;
        return;
      }
      if (runBlockedInfo.value?.kind === 'cloudflare') {
        showRunCloudflareModal.value = true;
        return;
      }
      showRunTroubleshoot.value = true;
    }

    async function sendLoginEnter() {
      if (loginJobId.value) {
        await api(`/api/jobs/${loginJobId.value}/stdin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '\n' })
        });
        await new Promise(r => setTimeout(r, 1200));
        await loadAuthStatus();
      }
    }

    async function startGenerate() {
      await startJob('generate', { strategy: gen.strategy, playbook: gen.playbook });
    }

    const discoverTransport = ref('browser');
    const apiDiscover = reactive({
      transport: 'api',
      url: 'http://localhost:3000/api/chat',
      uploadUrl: '',
      method: 'POST',
      responsePath: 'response',
      bodyJson: '{\n  "prompt": "{{prompt}}"\n}',
      headersJson: '{}',
    });
    const apiDiscoverJobId = ref(null);
    const apiDiscoverRunning = computed(() => {
      if (!apiDiscoverJobId.value) return false;
      const j = jobs.value.find(x => x.id === apiDiscoverJobId.value);
      return j && (j.status === 'running' || j.status === 'pending');
    });

    async function startApiDiscover() {
      let api_body = null;
      let api_headers = {};
      try { api_body = JSON.parse(apiDiscover.bodyJson || '{}'); } catch (e) {
        alert('Invalid request body JSON: ' + e.message);
        return;
      }
      try { api_headers = JSON.parse(apiDiscover.headersJson || '{}'); } catch (e) {
        alert('Invalid headers JSON: ' + e.message);
        return;
      }
      const j = await startJob('api_discover', {
        transport: apiDiscover.transport || 'api',
        api_url: apiDiscover.url,
        upload_url: apiDiscover.uploadUrl,
        api_method: apiDiscover.method,
        api_response_path: apiDiscover.responsePath,
        api_body,
        api_headers,
      });
      apiDiscoverJobId.value = j.id;
    }

    async function startDiscover() {
      const j = await startJob('discover');
      discoverJobId.value = j.id;
    }

    async function startManualDiscover() {
      const j = await startJob('manual_discover');
      manualDiscoverJobId.value = j.id;
    }

    async function sendEnter() {
      if (discoverJobId.value) {
        await api(`/api/jobs/${discoverJobId.value}/stdin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '\n' })
        });
      }
    }

    async function startRunTests() {
      runProgress.value = null;
      runLivePanelOpen.value = true;
      clearRunPreviews();
      await initRunPreviewConfig();
      runBlockedInfo.value = null;
      showRunLoginModal.value = false;
      showRunRateLimitModal.value = false;
      showRunCloudflareModal.value = false;
      resetRunCloudflareState();
      pendingRunAfterLogin.value = false;
      pendingRunAfterRateLimit.value = false;
      pendingRunAfterCloudflare.value = false;
      runLoginUrl.value = '';
      authSaveError.value = '';
      rateLimitWaiting.value = false;
      rateLimitCountdown.value = 0;
      _clearRateLimitTimer();
      if (run.strategy === '__all__') {
        await startJob('run_tests', { suite: '__all__', playbook: run.playbook, assess: run.assess });
      } else {
        await startJob('run_tests', { suite: run.playbook, assess: run.assess });
      }
    }

    async function startSampleRequest() {
      await startJob('sample_request', { prompt: 'capital of england' });
    }

    async function startSecurityAssess() {
      runProgress.value = null;
      const windowId = riskWindowIdFromValue(risk.log);
      const params = {};
      if (windowId) {
        params.time_window = windowId;
      } else {
        params.attack_log = risk.log;
      }
      await startJob('security_assess', params);
    }

    async function startExport() {
      expResult.value = null;
      if (!expSelectedRiskLevels.value.length) return;
      const windowId = riskWindowIdFromValue(exp.report);
      const params = {};
      if (windowId) {
        params.time_window = windowId;
      } else {
        params.report = exp.report;
      }
      const job = await startJob('export', params);
      if (job && job.id) {
        const poll = setInterval(async () => {
          const j = await api(`/api/jobs/${job.id}`);
          if (j.status !== 'running' && j.status !== 'pending') {
            clearInterval(poll);
            try { expResult.value = await api(`/api/jobs/${job.id}/export-result`); } catch { /* ignore */ }
          }
        }, 2000);
      }
    }

    async function startClearCache() {
      await startJob('clear_cache', { delete_on_server: cache.deleteOnServer });
    }

    let _pollTimer = null;

    function _schedulePoll() {
      if (_pollTimer) return;
      _pollTimer = setInterval(async () => {
        const hasRunning = jobs.value.some(j => j.status === 'running' || j.status === 'pending');
        if (hasRunning) {
          await refreshJobs();
        } else {
          clearInterval(_pollTimer);
          _pollTimer = null;
        }
      }, 10000);
    }

    async function openModal() {
      modalError.value = '';
      modalMsg.value = '';
      modalNewSite.value = '';
      modalNewComponent.value = '';
      if (site.value) {
        modalSite.value = site.value;
        modalComponents.value = components.value.length ? [...components.value] : await api(`/api/sites/${encodeURIComponent(site.value)}/components`);
        modalComponent.value = component.value || '';
        modalRenameSite.value = modalSite.value;
        modalRenameComponent.value = modalComponent.value;
      } else {
        // Pre-fill from .env defaults if available
        try {
          const defaults = await api('/api/env-defaults');
          if (defaults.target && sites.value.includes(defaults.target)) {
            modalSite.value = defaults.target;
            modalComponents.value = await api(`/api/sites/${encodeURIComponent(defaults.target)}/components`);
            modalComponent.value = defaults.component && modalComponents.value.includes(defaults.component)
              ? defaults.component
              : '';
            modalRenameSite.value = modalSite.value;
            modalRenameComponent.value = modalComponent.value;
          } else {
            modalSite.value = '';
            modalComponent.value = '';
            modalRenameSite.value = '';
            modalRenameComponent.value = '';
            modalComponents.value = [];
          }
        } catch {
          modalSite.value = '';
          modalComponent.value = '';
          modalRenameSite.value = '';
          modalRenameComponent.value = '';
          modalComponents.value = [];
        }
      }
      showModal.value = true;
    }

    onMounted(async () => {
      await loadSites();
      await refreshJobs();
      if (!site.value) {
        try {
          if (await applyEnvDefaults()) return;
        } catch { /* fall through to modal */ }
        openModal();
      }
    });

    watch(tab, () => {
      if (tab.value === 'settings') {
        if (settingsTab.value === 'browser') loadConfig();
        else if (settingsTab.value === 'component') loadCompCfg();
        else if (settingsTab.value === 'cache') loadCacheSettings();
      } else if (tab.value === 'export' || tab.value === 'risk') {
        loadExportSettings();
        if (tab.value === 'export') loadLogs();
      } else if (tab.value === 'tests') tmLoadStrategies();
      else if (tab.value === 'payloads') { loadPayloadTypes(); loadPayloadFiles(); }
      else if (tab.value === 'discover') loadAuthStatus();
      else if (tab.value === 'run') initRunPreviewConfig();
      else if (site.value && component.value) loadContext();
    });

    watch(settingsTab, () => {
      if (tab.value !== 'settings') return;
      if (settingsTab.value === 'browser') loadConfig();
      else if (settingsTab.value === 'component') loadCompCfg();
      else if (settingsTab.value === 'cache') loadCacheSettings();
    });

    return {
      site, component, sites, components, tab, settingsTab, tabs, jobsOpen, jobs, activeJobs,
      showRunTroubleshoot,
      showRunLoginModal, runLoginUrl, runBlockedInfo, pendingRunAfterLogin, authSaving, authSaveError,
      showRunRateLimitModal, showRunCloudflareModal, pendingRunAfterCloudflare,
      cloudflareModalNeedsSettings, cloudflareModalTimedOut, runCloudflareSettings, runCloudflareSaving, runCloudflareError,
      runCloudflareTestsStopped, dismissRunCloudflareModal, onCloudflareBackdropClick,
      cancelRunTestsFromCloudflare, applyCloudflareSettingsAndRerun, rerunAfterCloudflareTimeout,
      runRateLimitBackoffSec, rateLimitCountdown, rateLimitWaiting, pendingRunAfterRateLimit,
      confirmRateLimitResume, dismissRunRateLimitModal,
      runPreviewBySlot, runPreviewConfig, runPreviewSlotIndices,
      previewForSlot, hasRunLivePreview, runLivePanelVisible, runLivePanelOpen, runPreviewModalSlot,
      showRunPreviewModal, runPreviewModalUrl, runPreviewModalLabel,
      openRunPreviewModal, closeRunPreviewModal,
      confirmRunLogin, saveAuth, dismissRunLoginModal, onRunTroubleshoot,
      allStrategies, allPlaybooks, runStrategies, runPlaybooks, runAllPlaybooks, logs,
      gen, run, runArtifactStatus, runUploadWarning, risk, RISK_TIME_WINDOWS, riskWindowCounts, riskAssessEnabled, riskWindowValue, exportWindowCounts, exportEnabled, exp, EXPORT_RISK_LEVELS, expSelectedRiskLevels, toggleExpRiskLevel, cache,
      showPlaybookModal, pbForm, pbGenerating, pbError, pbMsg, pbIdTouched, pbSuggestId, openPlaybookModal, closePlaybookModal, submitPlaybookGenerate,
      showModal, modalSite, modalComponent, modalComponents, modalNewSite, modalNewComponent,
      modalRenameSite, modalRenameComponent, modalError, modalMsg,
      onModalSiteChange, onModalComponentChange, confirmModal, openModal,
      modalCreateSite, modalRenameSiteAction, modalDeleteSite,
      modalCreateComponent, modalRenameComponentAction, modalDeleteComponent,
      HINTS, hintDismissed, dismissHint,
      runResults, runResultsLoading, expandedRunRows, toggleRunRow,
      compCfg, compCfgSaved, compCfgError, compCfgEmpty, INPUT_TYPES, PROMPT_TEMPLATE_HINT, PROMPT_BODY_PLACEHOLDER,
      settingsSchema, compSettings, compSettingsInherited,
      settingMeta, settingLabel, formatSettingGlobal, onCompSettingInheritChange, toggleCompSettingSet,
      loadCompCfg, saveCompCfg, addInput, removeInput,
      cfg, cfgSaved, cfgError,
      BLOCKED_OPTIONS, COUNTRIES, CHANNELS, FETCH_METHODS,
      discoverJobId, discoverRunning, manualDiscoverJobId, manualDiscoverRunning,
      discoverTransport, apiDiscover, apiDiscoverRunning,
      startApiDiscover,
      sampleRequestRunning,
      loginJobId, loginRunning, loginUrl, authConfigured, authMode, authLoginChoice, authPublicSaving,
      chooseAuthRequired, chooseAuthNotRequired, resetAuthSetup,
      startLogin, sendLoginEnter,
      pretty, lineClass, activeOutput, panelOutput, runProgress, runProgressBarLabel, runProgressEtaText, riskTabProgressBarVisible, formatRunEta,
      onSiteChange, onComponentChange, loadContext, loadRunPlaybooks, refreshRunTests,
      tmStrategy, tmStrategies, tmPlaybook, tmPlaybooks, tmFile, tmDirty, tmSaving, tmSaveMsg,
      tmEditingId, tmAddingCategory, tmNewPrompt, tmImportFile, tmImportName, tmImporting, tmImportMsg,
      tmGeneratePayloadForPrompt, tmPayloadGenMsg, tmPayloadGenBusy, PAYLOAD_GENERATORS,
      tmPromptKind, tmPromptKindLabel, tmPromptPreview,
      tmIsMultiTurnStrategy, tmIsFewShotStrategy, tmIsMultimodalStrategy,
      tmAddTurn, tmRemoveTurn, tmAddExample, tmRemoveExample, TM_EXAMPLE_BEHAVIORS,
      payloadTypes, payloadAssetType, payloadForm, payloadFiles, payloadGenBusy, payloadGenResult, payloadGenError,
      loadPayloadTypes, loadPayloadFiles, generatePayloadAsset, payloadDownloadUrl, resetPayloadForm,
      tmLoadStrategies, tmLoadPlaybooks, tmLoadFile, tmSave, tmDeletePrompt, tmStartAdd, tmConfirmAdd, tmMarkDirty,
      tmImportFileChanged, tmImportZeroShot,
      startGenerate, startDiscover, startManualDiscover, sendEnter,
      startRunTests, startSampleRequest, startSecurityAssess, startExport, startClearCache,
      loadCacheSettings, saveCacheSettings, cacheSettingsSaving, cacheSettingsMsg,
      expResult, expPreview, expCreds, expCredsEdit, expCredsSaving, expCredsMsg,
      loadExpCreds, saveExpCreds, clearExpCreds, loadExportSettings, saveExportSettings,
      expSaved, expSaving, expSaveError,
      cancelJob, saveConfig, toggleBlocked,
    };
  }
}).mount('#app');

