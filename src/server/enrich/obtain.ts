import { OBTAIN_HINT, OBTAIN_LABEL, type ObtainMode } from "../../shared/taxonomy.ts";

/**
 * Obtain mode: separates "click and get it free" from "looks like a freebie but is not quite".
 * The price dimension (is_free / price) answers "does it cost money"; this one answers "can you be sure to get it".
 * The enum and its labels live in shared/taxonomy.ts so the frontend reuses the same copy.
 */
export type { ObtainMode };
export { OBTAIN_HINT, OBTAIN_LABEL };

/** Only these two count as genuinely "completely free". */
export const CLEAN_OBTAIN: ObtainMode[] = ["free"];

/**
 * Rule fallback: a rough keyword split for when the AI gives no verdict.
 * The order is deliberate - lottery before conditional, promo before free ("free trial of our service" is an ad).
 */
export function guessObtain(title: string, summary = ""): ObtainMode {
  const t = title + " " + summary;

  // Lottery / limited slots: whether you get it is not up to you
  if (/抽奖|抽\s*\d+\s*(份|个|名|位)|抽取|随机送|开奖|中奖|摇号|锦鲤|抽\s*\d+|名额有限.*抽|抽名额/.test(t)) {
    return "lottery";
  }
  // Promo / ad: the freebie is only the hook
  if (/招募|代理|加盟|官方旗舰|我们的服务|自营|软广|推广位|商务合作|招商|诚招|带货|优惠码.*分成/.test(t)) {
    return "promo";
  }
  // Trial: charged once it expires
  if (/试用|免费体验\s*\d+\s*天|首月免费|首月\s*\d|体验期|试用期|免费体验卡|7\s*天免费|30\s*天免费|\b(?:free\s+trial|demo\s+(?:is\s+)?(?:now\s+)?available)\b|(?:\bfree\b.*\bdemo\b|\bdemo\b.*\bfree\b)/i.test(t)) {
    return "trial";
  }
  // Conditional: you must take an action to get it
  if (/回帖|盖楼|转发|关注.*领取|邀请|拉新|实名|绑卡|下单|首单|充值|发帖|评论.*领取|签到.*领|分享.*得/.test(t)) {
    return "conditional";
  }
  return "free";
}
