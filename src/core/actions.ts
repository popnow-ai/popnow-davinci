/**
 * What the panel can do. Each action names the PopNow tool it calls, where its input comes from
 * (the clip under the playhead, the current frame, or only text), what comes back and how the
 * arguments are built. The panel renders the fields; nothing here touches Resolve or the network.
 */

export type Source = "clip" | "frame" | "text";
export type Output = "video" | "audio" | "image";

export interface Option {
  value: string;
  label: string;
}

export interface Field {
  key: string;
  label: string;
  kind: "prompt" | "select" | "toggle";
  placeholder?: string;
  options?: Option[];
  default?: string | boolean;
  required?: boolean;
}

export interface BuildInput {
  /** Field values from the panel. */
  values: Record<string, unknown>;
  /** popnow:// link of the uploaded clip or frame (clip and frame actions). */
  media?: string;
  /** Length of the clip on the timeline, in seconds (clip actions). */
  clipSeconds?: number;
}

export interface Action {
  id: string;
  tool: string;
  title: string;
  source: Source;
  output: Output;
  /** No credits are used; the panel skips the price check. */
  free?: boolean;
  /** The user must tick the consent box before it can start (face and voice). */
  consent?: boolean;
  /** Short word for the button on clip actions: "Edit · 3.0 s · 400 credits". */
  verb?: string;
  fields: Field[];
  build: (input: BuildInput) => Record<string, unknown>;
}

const text = (values: Record<string, unknown>, key: string): string => {
  const value = values[key];
  return typeof value === "string" ? value.trim() : "";
};

const need = (values: Record<string, unknown>, key: string, what: string): string => {
  const value = text(values, key);
  if (!value) throw new TypeError(`Write ${what} first.`);
  return value;
};

const media = (input: BuildInput): string => {
  if (!input.media) throw new TypeError("No clip or frame was sent to PopNow.");
  return input.media;
};

const SECONDS: Option[] = [
  { value: "5", label: "5 s" },
  { value: "10", label: "10 s" },
];

const SHAPES: Option[] = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
];

const LANGUAGES: Option[] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh-CN", "Chinese (Simplified)"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["ru", "Russian"],
].map(([value, label]) => ({ value: value as string, label: label as string }));

const VOICES: Option[] = [
  ["Kore", "Kore · warm"],
  ["Puck", "Puck · upbeat"],
  ["Charon", "Charon · deep"],
  ["Aoede", "Aoede · bright"],
  ["Fenrir", "Fenrir · excited"],
  ["Leda", "Leda · young"],
].map(([value, label]) => ({ value: value as string, label: label as string }));

export const ACTIONS: readonly Action[] = [
  {
    id: "edit-video",
    verb: "Edit",
    tool: "edit_video",
    title: "Edit video",
    source: "clip",
    output: "video",
    fields: [{ key: "prompt", label: "What to change", kind: "prompt", placeholder: "Make it a snowy night", required: true }],
    build: (input) => ({ video_url: media(input), prompt: need(input.values, "prompt", "what to change") }),
  },
  {
    id: "add-sound",
    verb: "Add sound",
    tool: "add_sound",
    title: "Video to audio",
    source: "clip",
    output: "audio",
    fields: [{ key: "prompt", label: "Sounds", kind: "prompt", placeholder: "Rain on a window, distant thunder" }],
    build: (input) => {
      const prompt = text(input.values, "prompt");
      const seconds = Math.min(30, Math.max(1, Math.round(input.clipSeconds ?? 8)));
      return { video_url: media(input), duration_seconds: seconds, ...(prompt ? { prompt } : {}) };
    },
  },
  {
    id: "translate",
    verb: "Translate",
    tool: "translate_video",
    title: "Video translator",
    source: "clip",
    output: "video",
    consent: true,
    fields: [{ key: "target_language", label: "Into", kind: "select", options: LANGUAGES, default: "es", required: true }],
    build: (input) => ({ video_url: media(input), target_language: need(input.values, "target_language", "a language") }),
  },
  {
    id: "upscale",
    verb: "Upscale",
    tool: "upscale",
    title: "Upscale",
    source: "clip",
    output: "video",
    fields: [
      {
        key: "size",
        label: "Size",
        kind: "select",
        options: [
          { value: "1080p", label: "1080p" },
          { value: "2k", label: "2K" },
          { value: "4k", label: "4K" },
        ],
        default: "1080p",
      },
    ],
    build: (input) => ({ video_url: media(input), size: text(input.values, "size") || "1080p" }),
  },
  {
    id: "reframe",
    verb: "Reframe",
    tool: "reframe_video",
    title: "Reframe",
    source: "clip",
    output: "video",
    free: true,
    fields: [{ key: "aspect_ratio", label: "Shape", kind: "select", options: SHAPES.slice().reverse(), default: "9:16", required: true }],
    build: (input) => ({ video_url: media(input), aspect_ratio: text(input.values, "aspect_ratio") || "9:16" }),
  },
  {
    id: "edit-frame",
    tool: "edit_image",
    title: "Edit image",
    source: "frame",
    output: "image",
    fields: [{ key: "prompt", label: "What to change", kind: "prompt", placeholder: "Golden hour light, add fog", required: true }],
    build: (input) => ({ image_url: media(input), prompt: need(input.values, "prompt", "what to change") }),
  },
  {
    id: "frame-to-video",
    tool: "create_video",
    title: "Image to video",
    source: "frame",
    output: "video",
    fields: [
      { key: "prompt", label: "What happens", kind: "prompt", placeholder: "Slow push in as the door opens", required: true },
      { key: "duration_seconds", label: "Length", kind: "select", options: SECONDS, default: "5" },
    ],
    build: (input) => ({
      image_url: media(input),
      prompt: need(input.values, "prompt", "what happens"),
      duration_seconds: Number(text(input.values, "duration_seconds") || "5"),
    }),
  },
  {
    id: "text-to-video",
    tool: "create_video",
    title: "Text to video",
    source: "text",
    output: "video",
    fields: [
      { key: "prompt", label: "Describe the shot", kind: "prompt", placeholder: "Drone shot over a foggy pine forest at dawn", required: true },
      { key: "aspect_ratio", label: "Shape", kind: "select", options: SHAPES, default: "16:9" },
      { key: "duration_seconds", label: "Length", kind: "select", options: SECONDS, default: "5" },
    ],
    build: (input) => ({
      prompt: need(input.values, "prompt", "the shot"),
      aspect_ratio: text(input.values, "aspect_ratio") || "16:9",
      duration_seconds: Number(text(input.values, "duration_seconds") || "5"),
    }),
  },
  {
    id: "music",
    tool: "create_music",
    title: "Music",
    source: "text",
    output: "audio",
    fields: [
      { key: "prompt", label: "The track", kind: "prompt", placeholder: "Warm lo-fi beat for a travel montage", required: true },
      { key: "instrumental", label: "Instrumental", kind: "toggle", default: true },
    ],
    build: (input) => ({
      prompt: need(input.values, "prompt", "the track"),
      instrumental: input.values.instrumental !== false,
    }),
  },
  {
    id: "voiceover",
    tool: "create_speech",
    title: "Voiceover",
    source: "text",
    output: "audio",
    fields: [
      { key: "text", label: "Script", kind: "prompt", placeholder: "Every journey starts with one step.", required: true },
      { key: "voice", label: "Voice", kind: "select", options: VOICES, default: "Kore" },
    ],
    build: (input) => ({ text: need(input.values, "text", "the script"), voice: text(input.values, "voice") || "Kore" }),
  },
];

export function actionById(id: string): Action {
  const action = ACTIONS.find((item) => item.id === id);
  if (!action) throw new TypeError(`Unknown action: ${id}`);
  return action;
}

/** Default field values for an action, as the panel shows them first. */
export function defaults(action: Action): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of action.fields) if (field.default !== undefined) out[field.key] = field.default;
  return out;
}
