import { cleanText, parseDate } from "../enrich/normalize.ts";
import { flaresolverrGet, hasFlare } from "../flaresolverr.ts";
import type { Collector, RawItem } from "./types.ts";

function stripTags(html: string): string {
  return cleanText(html.replace(/<br\s*\/?>/gi, "\n"), 400);
}

/**
 * Netdisk channels have two common kinds of dirty title:
 *   1. 「《漂流瓶》 分类: #教程 #资料 #图书 1. xxx 2. xxx」-- channel column name + tags + numbered list
 *   2. 「名称:欲望的陷阱 [内封简繁英字幕]」-- a field name used as the title
 * Only these two prefixes are cleaned; ordinary channels (tg-cn-deals / tg-freegames) are unaffected.
 */
function cleanTgTitle(raw: string): string {
  const cleaned = raw
    .replace(/^《[^》]{1,24}》\s*分类[:：]\s*(?:#[^\s#]+\s*)+/u, "")
    .replace(/^名称[:：]\s*/u, "");
  // when two fields like「名称:白蛇传 描述:2006年版...」are crammed onto one line, the title keeps only the name part;
  // the split entries also carry「1. 」「2、」numbering, which is stripped as well
  return cleaned.split(/\s*描述[:：]/u)[0]!.replace(/^\d{1,2}[.、]\s*/u, "").trim();
}

/**
 * Split a post such as「1. A 2. B 3. C」that packs several resources into one message into separate items.
 * Only enabled when the source config has splitNumbered=true: every @YioveComplex message lists 4-6 resources,
 * and without splitting only the first one shows in the title while the rest are lost.
 */
function splitNumberedEntries(text: string): string[] {
  const parts = text
    .split(/(?=(?<![\d.])\d{1,2}[.、]\s*[【\[「《(（A-Za-z\u4e00-\u9fff])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
  return parts.length > 1 ? parts : [];
}

type Message = { postId: string; text: string; datetime: string | null; imageUrl: string | null };

function extractTgImage(block: string): string | null {
  const bg = /tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/i.exec(block);
  if (bg?.[1]) return bg[1];
  const img = /<img[^>]+src="([^"]+)"/i.exec(block);
  if (img?.[1] && !/emoji|avatar/i.test(img[1])) return img[1];
  return null;
}

function parseChannelPage(html: string): Message[] {
  const out: Message[] = [];
  const blocks = html.split('class="tgme_widget_message_wrap');
  for (const block of blocks.slice(1)) {
    const idMatch = /data-post="([^"/]+)\/(\d+)"/.exec(block);
    if (!idMatch) continue;
    const textMatch = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const timeMatch = /<time[^>]*datetime="([^"]+)"/.exec(block);
    if (!textMatch) continue;
    out.push({
      postId: idMatch[2] ?? "",
      text: stripTags(textMatch[1] ?? ""),
      datetime: timeMatch?.[1] ?? null,
      imageUrl: extractTgImage(block),
    });
  }
  return out;
}

export const telegramCollector: Collector = {
  kind: "telegram",
  label: "Telegram 频道",
  defaults: { config: { channels: [] } },
  async collect(ctx) {
    const channels = (ctx.config.channels as string[] | undefined) ?? [];
    if (!channels.length) throw new Error("未配置 channels");
    const splitNumbered = ctx.config.splitNumbered === true;

    const items: RawItem[] = [];
    const problems: string[] = [];
    let ok = 0;

    for (const channel of channels) {
      const url = "https://t.me/s/" + channel;
      try {
        // t.me public preview pages work with a direct request; only fall back to FlareSolverr when that fails to parse.
        // it used to go through FlareSolverr unconditionally, which returned a captcha page and always parsed 0 entries.
        let body = "";
        const direct = await ctx.http.text(url).catch(() => null);
        if (direct && direct.status === 200) body = direct.body;
        let messages = body ? parseChannelPage(body).slice(-30) : [];
        if (!messages.length && hasFlare()) {
          const res = await flaresolverrGet(url);
          if (res.status === 200) {
            body = res.body;
            messages = parseChannelPage(body).slice(-30);
          }
        }
        if (!messages.length) throw new Error("页面解析不到消息（频道不存在或页面结构变化）");

        ctx.log(channel + " parsed " + messages.length + " messages");
        ok += 1;
        for (const m of messages) {
          if (!m.text) continue;
          const body = m.text.replace(/^《[^》]{1,24}》\s*分类[:：]\s*(?:#[^\s#]+\s*)+/u, "");
          const chunks = splitNumbered ? splitNumberedEntries(body) : [];
          if (chunks.length > 1) {
            // one message holds several resources: split it up and add a sequence suffix to externalId to avoid primary-key conflicts
            chunks.forEach((chunk, idx) => {
              const title = cleanTgTitle(chunk).slice(0, 180);
              if (!title) return;
              items.push({
                externalId: channel + "/" + m.postId + "-" + idx,
                // url_key has a UNIQUE constraint, so items split from one message must carry different query strings or only the first one is stored
                url: url + "/" + m.postId + "?part=" + idx,
                title,
                summary: chunk.slice(0, 400),
                content: chunk,
                author: channel,
                publishedAt: parseDate(m.datetime),
                tags: ["telegram", channel],
                imageUrl: m.imageUrl,
                raw: { channel, postId: m.postId, part: idx },
              });
            });
            continue;
          }
          const firstLine = m.text.split("\n")[0] ?? m.text;
          items.push({
            externalId: channel + "/" + m.postId,
            url: url + "/" + m.postId,
            title: cleanTgTitle(firstLine).slice(0, 180),
            summary: m.text.slice(0, 400),
            content: m.text,
            author: channel,
            publishedAt: parseDate(m.datetime),
            tags: ["telegram", channel],
            imageUrl: m.imageUrl,
            raw: { channel, postId: m.postId },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        problems.push(channel + ": " + message);
        ctx.log(channel + " FAILED " + message);
      }
    }

    if (!ok && problems.length) throw new Error("全部频道失败: " + problems.join("; "));

    return {
      items: items.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};
