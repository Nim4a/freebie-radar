/**
 * Persian labels for the Telegram surfaces only.
 *
 * The web UI and RSS share the English copy in shared/taxonomy.ts, so this file
 * re-keys the same enums with Persian labels instead of translating the shared table.
 * Display only: every filter keeps comparing the raw enum keys.
 */

/** Persian copy for the content kinds shown in Telegram meta lines. */
export const KIND_LABEL_FA: Record<string, string> = {
  freebie: "هدیه",
  deal: "تخفیف",
  opensource: "متن‌باز",
  news: "خبر مهم",
  info: "خبر صنعت",
  noise: "نامرتبط",
};

/** Persian copy for the categories shown in Telegram meta lines. */
export const CATEGORY_LABEL_FA: Record<string, string> = {
  ai: "اعتبار هوش مصنوعی",
  cloud: "سرویس ابری",
  vps: "سرور مجازی",
  domain: "دامنه و سایت",
  opensource: "متن‌باز",
  software: "لایسنس نرم‌افزار",
  dev: "توسعه و مهندسی",
  design: "طراحی و دارایی",
  security: "امنیت و شبکه",
  hardware: "سخت‌افزار",
  media: "اشتراک رسانه",
  game: "بازی",
  carpool: "اشتراک گروهی",
  trade: "معامله و انتقال",
  headline: "سیاست",
  world: "جهان",
  finance: "اقتصاد",
  stock: "بازار سهام",
  tech: "فناوری",
  news: "خبر",
  goods: "کالای روزمره",
  lottery: "قرعه‌کشی",
  offline: "حضوری و فیزیکی",
  invite: "دعوت‌نامه",
  edu: "آموزش",
  pan: "فضای ابری",
  course: "دوره",
  other: "سایر",
};

/** Persian copy for the obtain modes ("can you be sure to get it"). */
export const OBTAIN_LABEL_FA: Record<string, string> = {
  free: "رایگان",
  conditional: "شرطی",
  lottery: "قرعه‌کشی",
  trial: "آزمایشی",
  promo: "تبلیغ",
  paid: "پرداختی",
};

export function kindLabelFa(kind: string | null | undefined): string | null {
  return kind ? KIND_LABEL_FA[kind] ?? null : null;
}

export function categoryLabelFa(category: string | null | undefined): string {
  return category ? CATEGORY_LABEL_FA[category] ?? category : "سایر";
}

export function obtainLabelFa(obtain: string | null | undefined): string | null {
  return obtain ? OBTAIN_LABEL_FA[obtain] ?? null : null;
}
