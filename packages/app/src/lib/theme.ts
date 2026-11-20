/** Interface themes: "device" follows the operating system (prefers-color-scheme). */
export const THEMES = ["dark", "light", "device"] as const;
export type Theme = (typeof THEMES)[number];

/** Theme chosen on this browser (settings or anonymous menu), one year. No cookie: "device". */
export const THEME_COOKIE = "kwazat_theme";

export const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);
export const parseTheme = (value: unknown): Theme => (isTheme(value) ? value : "device");
