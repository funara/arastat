<script setup lang="ts">
// AI Settings + Google AI Studio key guide + About (Phase 8 §8.2.E): the three
// dialogs moved out of App.vue — markup verbatim, every rule stays in ara.css.
import { computed, nextTick, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    pushThreshold: number;
    /** Which dialog the host wants when `open` flips true (About menu entry). */
    initialView?: "settings" | "about";
  }>(),
  { initialView: "settings" },
);

const emit = defineEmits<{
  (e: "close"): void;
  /** Successful save: the host mirrors the clamped splitter push threshold. */
  (e: "saved", pushThreshold: number): void;
  /** Same messages the host used to toast itself. */
  (e: "toast", message: string): void;
}>();

/** Splitter push threshold (px), seeded from storage; falls back to the host. */
function seedPushThreshold(): number {
  const raw = localStorage.getItem("ara:ai-push-threshold");
  const n = Number(raw);
  return raw !== null && Number.isFinite(n)
    ? Math.max(0, Math.min(400, n))
    : props.pushThreshold;
}

const aboutOpen = ref(false);
const aboutDlg = ref<HTMLDialogElement | null>(null);
/** Set while one card is closed only to hand over to the other. */
let ignoreNextSettingsClose = false;
let ignoreNextAboutClose = false;

/* The host owns `open`; this watcher reveals exactly one dialog each time it
   flips true, and `initialView` picks which. Switching views closes the other,
   so only one card is ever modal. */
watch(
  () => [props.open, props.initialView] as const,
  ([open, initialView]) => {
    if (!open) return;
    if (initialView === "about") showAbout();
    else void showSettings();
  },
  { immediate: true },
);

function showAbout(): void {
  if (settingsDlg.value?.open) {
    // The settings card yields to About. Its `close` event arrives asynchronously,
    // so flag it to be swallowed — the host's single `open` flag must stay on.
    ignoreNextSettingsClose = true;
    settingsDlg.value.close();
  }
  aboutOpen.value = true;
  void nextTick(() => {
    const d = aboutDlg.value;
    if (d && !d.open) d.showModal();
  });
}

function closeAbout(): void {
  aboutDlg.value?.close();
  aboutOpen.value = false;
}

function openAuthorLink(): void {
  window.open("https://adhirahmadian.id", "_blank");
}

const settingsOpen = ref(false);
const settingsDlg = ref<HTMLDialogElement | null>(null);
type AiProvider = "google" | "custom";
interface SettingsForm {
  provider: AiProvider;
  baseUrl: string;
  key: string;
  model: string;
  pushThreshold: number;
}
const settingsForm = ref<SettingsForm>({
  provider: "google",
  baseUrl: "",
  key: "",
  model: "",
  pushThreshold: seedPushThreshold(),
});
const showAiKey = ref(false);
// Hints are kept per provider: the key stored for Google must not be advertised
// on the Custom tab (and vice versa).
const savedKeyHints = ref<{ google: string; custom: string }>({
  google: "",
  custom: "",
});
const savedAiKeyHint = computed(() => {
  const hint = savedKeyHints.value[settingsForm.value.provider];
  return hint ? `Saved key: ••••${hint}. Enter a new key to replace it.` : "";
});
const settingsError = ref("");

const GOOGLE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

/* ---------- Google Key Guide Dialog ---------- */
const keyGuideOpen = ref(false);
const keyGuideDlg = ref<HTMLDialogElement | null>(null);

function openGoogleKeyGuide(): void {
  keyGuideOpen.value = true;
  void nextTick(() => keyGuideDlg.value?.showModal());
}

function closeGoogleKeyGuide(): void {
  keyGuideDlg.value?.close();
  keyGuideOpen.value = false;
}

function openAiStudioLink(): void {
  window.open("https://aistudio.google.com/apikey", "_blank");
}

async function showSettings(): Promise<void> {
  if (settingsOpen.value || settingsDlg.value?.open) return;
  if (aboutDlg.value?.open) {
    // Handing over from About: its `close` event fires later and would flip the
    // host's `open` flag off, so swallow it the same way as the reverse switch.
    ignoreNextAboutClose = true;
    aboutDlg.value.close();
  }
  settingsOpen.value = true;
  await nextTick();
  const dialog = settingsDlg.value;
  if (dialog && !dialog.open) dialog.showModal();
  try {
    const s = await window.ara.ai.getSettings();
    const provider = s.provider;
    const savedProvider: AiProvider =
      provider === "custom" ? "custom" : "google";
    savedKeyHints.value = s.keyHints;
    settingsForm.value = {
      provider: savedProvider,
      baseUrl: s.baseUrl,
      key: "",
      model:
        s.model ||
        (savedProvider === "google" ? "gemini-3.8-flash" : "gpt-4o-mini"),
      pushThreshold: props.pushThreshold,
    };
  } catch {
    savedKeyHints.value = { google: "", custom: "" };
    settingsForm.value = {
      provider: "google",
      baseUrl: "",
      key: "",
      model: "",
      pushThreshold: props.pushThreshold,
    };
  }
}

function closeSettings(): void {
  settingsDlg.value?.close();
}

function isLocalUrl(url: string): boolean {
  if (!url) return false;
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/i.test(url.trim());
}

const customModelsList = ref<string[]>([]);
const isFetchingModels = ref(false);

async function fetchCustomModels(): Promise<void> {
  const url = settingsForm.value.baseUrl.trim();
  if (!url) {
    settingsError.value = "Please enter a Base URL first.";
    return;
  }
  isFetchingModels.value = true;
  settingsError.value = "";
  try {
    let models: string[] = [];
    if (window.ara?.ai?.listModels) {
      models = await window.ara.ai.listModels({
        baseUrl: url,
        key: settingsForm.value.key.trim(),
      });
    } else {
      const cleanUrl = url.replace(/\/+$/, "");
      const modelsUrl = cleanUrl.endsWith("/models")
        ? cleanUrl
        : `${cleanUrl}/models`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (settingsForm.value.key.trim()) {
        headers["authorization"] = `Bearer ${settingsForm.value.key.trim()}`;
      }
      const res = await fetch(modelsUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as unknown;
      if (json && typeof json === "object") {
        const rec = json as Record<string, unknown>;
        const list = Array.isArray(rec.data)
          ? rec.data
          : Array.isArray(rec.models)
            ? rec.models
            : [];
        models = list
          .map((m: any) => (typeof m === "string" ? m : m.id || m.name))
          .filter(Boolean);
      }
    }
    if (models.length > 0) {
      customModelsList.value = models;
      if (
        !settingsForm.value.model ||
        !models.includes(settingsForm.value.model)
      ) {
        settingsForm.value.model = models[0];
      }
      emit(
        "toast",
        `Fetched ${models.length} model${models.length === 1 ? "" : "s"}.`,
      );
    } else {
      emit(
        "toast",
        "No models returned by endpoint. You can enter model name manually.",
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    settingsError.value =
      msg.includes("Failed to fetch") || msg.includes("unreachable")
        ? "Could not reach endpoint. Check Base URL and ensure the service is running."
        : `Failed to fetch models: ${msg}`;
  } finally {
    isFetchingModels.value = false;
  }
}

function applyCustomPreset(
  preset: "ollama" | "lmstudio" | "anthropic" | "openai" | "openrouter",
): void {
  if (preset === "ollama") {
    settingsForm.value.baseUrl = "http://localhost:11434/v1";
    if (
      !settingsForm.value.model ||
      settingsForm.value.model === "gpt-4o-mini"
    ) {
      settingsForm.value.model = "llama3.2";
    }
  } else if (preset === "lmstudio") {
    settingsForm.value.baseUrl = "http://localhost:1234/v1";
    if (
      !settingsForm.value.model ||
      settingsForm.value.model === "gpt-4o-mini"
    ) {
      settingsForm.value.model = "local-model";
    }
  } else if (preset === "anthropic") {
    settingsForm.value.baseUrl = "https://api.anthropic.com/v1";
    settingsForm.value.model = "claude-3-7-sonnet";
  } else if (preset === "openai") {
    settingsForm.value.baseUrl = "https://api.openai.com/v1";
    settingsForm.value.model = "gpt-4o-mini";
  } else if (preset === "openrouter") {
    settingsForm.value.baseUrl = "https://openrouter.ai/api/v1";
    settingsForm.value.model = "anthropic/claude-3.7-sonnet";
  }
}

async function saveSettings(): Promise<void> {
  const key = settingsForm.value.key.trim();
  const isLocalCustom =
    settingsForm.value.provider === "custom" &&
    isLocalUrl(settingsForm.value.baseUrl);
  if (!key && !savedAiKeyHint.value && !isLocalCustom) {
    settingsError.value =
      settingsForm.value.provider === "google"
        ? "Please enter your Google AI Studio API key."
        : "Please enter your API key.";
    if (settingsForm.value.provider === "google") {
      document.getElementById("settingsKey")?.focus();
    } else {
      document.getElementById("settingsCustomKey")?.focus();
    }
    return;
  }
  settingsError.value = "";
  try {
    const modelToSave =
      settingsForm.value.provider === "google"
        ? settingsForm.value.model.trim() || "gemini-3.8-flash"
        : settingsForm.value.model.trim() || "gpt-4o-mini";
    const saved = await window.ara.ai.setSettings({
      provider: settingsForm.value.provider,
      baseUrl: settingsForm.value.baseUrl.trim(),
      ...(key ? { key } : {}),
      model: modelToSave,
    });
    savedKeyHints.value = saved.keyHints;
    const clamped = Math.max(
      0,
      Math.min(400, Number(settingsForm.value.pushThreshold) || 0),
    );
    settingsForm.value.pushThreshold = clamped;
    localStorage.setItem("ara:ai-push-threshold", String(clamped));
    emit("saved", clamped);
    closeSettings();
    emit("toast", "AI settings saved.");
  } catch {
    emit("toast", "The settings could not be saved. Try again.");
  }
}

// ::backdrop clicks retarget to the <dialog> element; the rect check keeps
// border clicks inside the card from closing it.
function onDialogBackdrop(e: MouseEvent, el: HTMLDialogElement | null): void {
  if (!el || e.target !== el) return;
  const r = el.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  )
    el.close();
}

/* Each element is the source of truth for its own visibility; these mirror the
   close back to the host, which owns `open`. */
function onSettingsClosed(): void {
  settingsOpen.value = false;
  if (ignoreNextSettingsClose) {
    ignoreNextSettingsClose = false;
    return;
  }
  emit("close");
}

function onAboutClosed(): void {
  aboutOpen.value = false;
  if (ignoreNextAboutClose) {
    ignoreNextAboutClose = false;
    return;
  }
  emit("close");
}
</script>

<template>
  <!-- AI Settings Dialog (Refined Provider & Settings Layout) -->
  <dialog
    v-if="settingsOpen"
    ref="settingsDlg"
    aria-labelledby="settingsTitle"
    class="settings-dlg"
    @click="onDialogBackdrop($event, settingsDlg)"
    @close="onSettingsClosed"
  >
    <div class="dlg-head settings-dlg-head">
      <div class="settings-dlg-title-wrap">
        <div class="settings-dlg-icon">
          <img src="/icon.png" alt="ARAStat" class="settings-dlg-app-icon" />
        </div>
        <div>
          <h3 id="settingsTitle">AI Settings</h3>
          <p class="settings-subtitle">
            Select your preferred AI engine for interpretation and insights.
          </p>
        </div>
      </div>
      <button
        class="settings-close-btn"
        type="button"
        aria-label="Close settings"
        @click="closeSettings"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="dlg-body settings-body">
      <!-- Provider Selection Cards (2-column balanced layout) -->
      <div
        class="provider-cards-grid"
        role="radiogroup"
        aria-label="AI Provider"
      >
        <!-- Gemini AI Card -->
        <button
          type="button"
          class="provider-card-btn"
          :class="{ active: settingsForm.provider === 'google' }"
          role="radio"
          :aria-checked="settingsForm.provider === 'google'"
          @click="settingsForm.provider = 'google'"
        >
          <div class="provider-card-header">
            <div class="provider-card-icon-wrap provider-icon-gemini">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="M12 3c0 4.97-4.03 9-9 9 4.97 0 9 4.03 9 9 0-4.97 4.03-9 9-9-4.97 0-9-4.03-9-9z"
                />
              </svg>
            </div>
            <div
              class="provider-radio-pill"
              :class="{ checked: settingsForm.provider === 'google' }"
            >
              <div class="radio-dot"></div>
            </div>
          </div>
          <span class="provider-card-title">Gemini AI</span>
          <span class="provider-card-desc"
            >Connect using a Google AI Studio API key.</span
          >
        </button>

        <!-- OpenAI / Custom Card -->
        <button
          type="button"
          class="provider-card-btn"
          :class="{ active: settingsForm.provider === 'custom' }"
          role="radio"
          :aria-checked="settingsForm.provider === 'custom'"
          @click="settingsForm.provider = 'custom'"
        >
          <div class="provider-card-header">
            <div class="provider-card-icon-wrap provider-icon-custom">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" />
                <line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </div>
            <div
              class="provider-radio-pill"
              :class="{ checked: settingsForm.provider === 'custom' }"
            >
              <div class="radio-dot"></div>
            </div>
          </div>
          <span class="provider-card-title">OpenAI-Compatible</span>
          <span class="provider-card-desc"
            >Connect to an OpenAI-compatible endpoint.</span
          >
        </button>
      </div>

      <!-- Google AI Studio Configuration -->
      <div
        v-if="settingsForm.provider === 'google'"
        class="provider-config-section"
      >
        <div class="google-guide-banner">
          <div class="google-guide-banner-text">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="guide-banner-icon"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span
              >Need a free Gemini key? Google AI Studio offers a free usage
              tier.</span
            >
          </div>
          <button
            type="button"
            class="guide-link-btn"
            @click="openGoogleKeyGuide"
          >
            How to get key ↗
          </button>
        </div>

        <label class="settings-field" for="settingsGoogleModel">
          <span class="settings-field-label">
            <span>Model</span>
            <span class="settings-tag-subtle"
              >Recommended: gemini-3.8-flash</span
            >
          </span>
          <div class="select-wrapper">
            <select id="settingsGoogleModel" v-model="settingsForm.model">
              <option v-for="m in GOOGLE_MODELS" :key="m" :value="m">
                {{ m }} {{ m === "gemini-3.8-flash" ? "(Recommended)" : "" }}
              </option>
            </select>
            <svg
              class="select-arrow"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </label>

        <label class="settings-field" for="settingsKey">
          <span class="settings-field-label">
            <span>Google AI Studio API Key</span>
            <span
              v-if="!savedAiKeyHint && !settingsForm.key"
              class="settings-tag-required"
            >
              Required
            </span>
          </span>
          <div class="input-with-button">
            <input
              id="settingsKey"
              v-model="settingsForm.key"
              :type="showAiKey ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              :placeholder="
                savedAiKeyHint || 'Paste key starting with AQ. or AIza...'
              "
              :aria-invalid="!!settingsError"
            />
            <button
              type="button"
              class="input-eye-btn"
              :title="showAiKey ? 'Hide key' : 'Show key'"
              :aria-label="showAiKey ? 'Hide key' : 'Show key'"
              @click="showAiKey = !showAiKey"
            >
              <svg
                v-if="!showAiKey"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg
                v-else
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
          </div>
          <span v-if="settingsError" class="settings-error" role="alert">{{
            settingsError
          }}</span>
          <span v-else class="settings-help">
            Stored locally on this machine. Requests are sent directly to Google
            AI Studio.
          </span>
        </label>
      </div>

      <!-- Custom / OpenAI Compatible Configuration -->
      <div v-else class="provider-config-section">
        <!-- Quick Presets -->
        <div class="preset-chips-wrap">
          <span class="preset-chips-label">Quick presets:</span>
          <div class="preset-chips-row">
            <button
              type="button"
              class="preset-chip"
              title="Fill Ollama default endpoint (http://localhost:11434/v1)"
              @click="applyCustomPreset('ollama')"
            >
              Ollama (Local)
            </button>
            <button
              type="button"
              class="preset-chip"
              title="Fill LM Studio default endpoint (http://localhost:1234/v1)"
              @click="applyCustomPreset('lmstudio')"
            >
              LM Studio
            </button>
            <button
              type="button"
              class="preset-chip"
              title="Fill Anthropic Claude endpoint"
              @click="applyCustomPreset('anthropic')"
            >
              Anthropic
            </button>
            <button
              type="button"
              class="preset-chip"
              title="Fill OpenAI official endpoint"
              @click="applyCustomPreset('openai')"
            >
              OpenAI
            </button>
            <button
              type="button"
              class="preset-chip"
              title="Fill OpenRouter gateway"
              @click="applyCustomPreset('openrouter')"
            >
              OpenRouter
            </button>
          </div>
        </div>

        <label class="settings-field" for="settingsBaseUrl">
          <span class="settings-field-label">
            <span>Base URL</span>
          </span>
          <input
            id="settingsBaseUrl"
            v-model="settingsForm.baseUrl"
            type="text"
            autocomplete="url"
            spellcheck="false"
            placeholder="https://api.openai.com/v1"
          />
        </label>

        <div class="settings-field">
          <div class="settings-field-label">
            <span>Model Name</span>
            <div class="model-fetch-actions">
              <button
                type="button"
                class="fetch-models-btn"
                :disabled="isFetchingModels || !settingsForm.baseUrl.trim()"
                :title="
                  !settingsForm.baseUrl.trim()
                    ? 'Enter a Base URL first'
                    : 'Fetch available models from the URL'
                "
                @click="fetchCustomModels"
              >
                <svg
                  v-if="!isFetchingModels"
                  class="fetch-icon"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path
                    d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
                  />
                </svg>
                <span v-else class="fetch-spinner"></span>
                <span>{{
                  isFetchingModels ? "Fetching..." : "Fetch models"
                }}</span>
              </button>
            </div>
          </div>

          <!-- When models fetched: dropdown select -->
          <div v-if="customModelsList.length > 0" class="select-wrapper">
            <select id="settingsCustomModel" v-model="settingsForm.model">
              <option v-for="m in customModelsList" :key="m" :value="m">
                {{ m }}
              </option>
            </select>
            <svg
              class="select-arrow"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>

          <!-- When no models fetched yet: text input -->
          <input
            v-else
            id="settingsCustomModel"
            v-model="settingsForm.model"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. gpt-4o-mini, llama3.2, or click Fetch models"
          />
        </div>

        <label class="settings-field" for="settingsCustomKey">
          <span class="settings-field-label">
            <span>API Key</span>
            <span
              v-if="
                !savedAiKeyHint &&
                !settingsForm.key &&
                !isLocalUrl(settingsForm.baseUrl)
              "
              class="settings-tag-required"
            >
              Required
            </span>
            <span
              v-else-if="isLocalUrl(settingsForm.baseUrl)"
              class="settings-tag-subtle"
            >
              Optional
            </span>
          </span>
          <div class="input-with-button">
            <input
              id="settingsCustomKey"
              v-model="settingsForm.key"
              :type="showAiKey ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              :placeholder="
                savedAiKeyHint ||
                (isLocalUrl(settingsForm.baseUrl)
                  ? 'Optional for local models'
                  : 'Paste API key here')
              "
              :aria-invalid="!!settingsError"
            />
            <button
              type="button"
              class="input-eye-btn"
              :title="showAiKey ? 'Hide key' : 'Show key'"
              :aria-label="showAiKey ? 'Hide key' : 'Show key'"
              @click="showAiKey = !showAiKey"
            >
              <svg
                v-if="!showAiKey"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg
                v-else
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
          </div>
          <span v-if="settingsError" class="settings-error" role="alert">{{
            settingsError
          }}</span>
        </label>
      </div>

      <!-- ZDR & Privacy Disclaimer -->
      <div class="settings-zdr-disclaimer">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span
          ><strong>Privacy Notice<br /></strong> By connecting an external AI
          provider, you acknowledge that your data is governed by its
          terms.</span
        >
      </div>
    </div>

    <div class="dlg-foot settings-dlg-foot">
      <div class="settings-privacy-note">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span
          >All API keys are encrypted and stored locally on your device.</span
        >
      </div>
      <button type="button" class="btn btn-primary" @click="saveSettings">
        Save Settings
      </button>
    </div>
  </dialog>

  <!-- Google AI Studio Key Guide Modal -->
  <dialog
    v-if="keyGuideOpen"
    ref="keyGuideDlg"
    class="key-guide-dlg"
    aria-labelledby="keyGuideTitle"
    @click="onDialogBackdrop($event, keyGuideDlg)"
    @close="keyGuideOpen = false"
  >
    <div class="dlg-head">
      <h3 id="keyGuideTitle">Get a Free Google AI Studio API Key</h3>
      <button
        class="icon-btn"
        type="button"
        aria-label="Close guide"
        @click="closeGoogleKeyGuide"
      >
        ×
      </button>
    </div>
    <div class="key-guide-body">
      <p>
        Google AI Studio provides free, rate-limited API access to Gemini models
        for testing, prototyping, and statistical research without requiring a
        credit card.
      </p>

      <ol class="key-guide-step-list">
        <li class="key-guide-step-item">
          <span class="step-num-badge">1</span>
          <div class="step-content">
            <strong>Visit Google AI Studio</strong>
            <span
              >Go to
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                >aistudio.google.com/apikey</a
              >
              and sign in with any Google account.</span
            >
          </div>
        </li>
        <li class="key-guide-step-item">
          <span class="step-num-badge">2</span>
          <div class="step-content">
            <strong>Create API Key</strong>
            <span
              >Click the blue <strong>Create API key</strong> button in the top
              left, and choose or create a Google Cloud project.</span
            >
          </div>
        </li>
        <li class="key-guide-step-item">
          <span class="step-num-badge">3</span>
          <div class="step-content">
            <strong>Copy your Key</strong>
            <span
              >Copy the generated key (it usually starts with
              <code>AIzaSy...</code>).</span
            >
          </div>
        </li>
        <li class="key-guide-step-item">
          <span class="step-num-badge">4</span>
          <div class="step-content">
            <strong>Paste into ARAStat</strong>
            <span
              >Select <strong>Gemini AI</strong> in AI Settings, paste your key,
              and click Save.</span
            >
          </div>
        </li>
      </ol>

      <div class="key-guide-callout">
        <strong>Recommended Models:</strong>
        <br />• <strong>gemini-3.8-flash</strong>: Fast, high-accuracy reasoning
        for hypothesis testing and diagnostics (Recommended). <br />•
        <strong>gemini-3.5-flash-lite</strong>: Blazing fast with generous rate
        limits, ideal for table insights. <br />•
        <strong>gemini-3.1-pro</strong>: In-depth statistical synthesis and
        advanced methodology.
      </div>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn btn-primary" @click="openAiStudioLink">
        Open Google AI Studio ↗
      </button>
    </div>
  </dialog>

  <!-- About dialog (Help > About ARAStat) -->
  <dialog
    v-if="aboutOpen"
    ref="aboutDlg"
    aria-label="About ARAStat"
    class="settings-dlg about-dlg"
    @click="onDialogBackdrop($event, aboutDlg)"
    @close="onAboutClosed"
  >
    <button
      class="icon-btn about-close"
      type="button"
      aria-label="Close about"
      @click="closeAbout"
    >
      ×
    </button>
    <div class="dlg-body about-body">
      <img src="/ARAStat.png" alt="ARAStat logo" class="about-logo" />
      <p class="about-text">
        Statistics workbench with an integrated AI copilot.<br />
        Author: Adhi Rahmadian (<button
          class="about-link"
          type="button"
          @click="openAuthorLink"
        >
          adhirahmadian.id</button
        >) <br />
        Version 0.1.0 · GNU GPL v3.0
      </p>
      <div class="about-card-box about-links">
        <div class="about-link-row">
          <div class="about-link-text">
            <strong>Need an API key?</strong
            ><span>Get a Gemini API key from Google AI Studio.</span>
          </div>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            @click="openAiStudioLink"
          >
            Get Google API keys ↗
          </button>
        </div>
      </div>
    </div>
  </dialog>
</template>
