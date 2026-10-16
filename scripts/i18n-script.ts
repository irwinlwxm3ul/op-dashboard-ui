// Script-purity and regional-wording checks for the priority locales (zh-CN, zh-TW, zh-HK, ja),
// used by scripts/check-i18n.ts and tests/i18n.test.ts.
//
// Character data comes from OpenCC (opencc-js dev dependency; nothing here ships to the client):
// * Simplified-only characters  = STCharacters sources that never appear on the Traditional side of
//   any OpenCC table. Ambiguous characters that are also normal Traditional characters (里 in 公里,
//   干 in 干擾, 后 in 皇后, 台, 游 in 游泳 …) are therefore NOT flagged.
// * Traditional-only characters = TSCharacters sources that never appear on the Simplified side.
// * Regional Traditional forms  = TWVariants / HKVariants (Taiwan 著 裡 說 戶 溫 衛 vs Hong Kong
//   着 裏 説 户 温 衞).
// * Japanese                    = JPShinjitaiCharacters (shinjitai 戦 弾 撃 … vs kyujitai 戰 彈 擊 …).
//
// Regional VOCABULARY is a short curated list of unambiguous Taiwan / Hong Kong / Mainland pairs;
// the full terminology lives in docs/i18n/glossary-east-asia.md.

import ST_CHARS from 'opencc-js/dict/STCharacters';
import TS_CHARS from 'opencc-js/dict/TSCharacters';
import ST_PHRASES from 'opencc-js/dict/STPhrases';
import TS_PHRASES from 'opencc-js/dict/TSPhrases';
import TW_VARIANTS from 'opencc-js/dict/TWVariants';
import HK_VARIANTS from 'opencc-js/dict/HKVariants';
import JP_SHINJITAI from 'opencc-js/dict/JPShinjitaiCharacters';

type StringDict = Readonly<Partial<Record<string, string>>>;

export interface ScriptIssue {
  key: string;
  /** Errors fail check:i18n; warnings are printed only. */
  level: 'error' | 'warn';
  message: string;
}

/** OpenCC dictionary string ("src dst1 dst2|src dst|…") as [source, targets] pairs. */
function parseDict(data: string): [string, string[]][] {
  return data.split('|').filter(Boolean).map((entry) => {
    const [src, ...dst] = entry.split(' ');
    return [src, dst];
  });
}

function charsOf(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const c of t) out.add(c);
  return out;
}

interface CharData {
  simplifiedOnly: ReadonlySet<string>;
  traditionalOnly: ReadonlySet<string>;
  /** OpenCC-standard Traditional forms Taiwan writes differently (着→著, 裏→裡, 爲→為). */
  notTaiwanForm: ReadonlyMap<string, string>;
  /** Forms that neither Taiwan nor Hong Kong uses (爲→為, 衆→眾, 僞→偽). */
  notRegionalForm: ReadonlyMap<string, string>;
  /** Hong Kong standard forms Taiwan never uses (説, 户, 温, 衞, 悦, 税 …). */
  hongKongOnlyForm: ReadonlyMap<string, string>;
  /** Forms the Hong Kong character standard writes differently (說→説, 戶→户, 溫→温, 衛→衞). */
  hongKongPrefers: ReadonlyMap<string, string>;
  /** Kyujitai / Traditional forms Japanese writes in shinjitai (戰→戦, 彈→弾, 擊→撃). */
  kyujitai: ReadonlyMap<string, string>;
  /** Simplified-only characters that are not Japanese shinjitai either (这, 们, 说, 战, 枪 …). */
  chineseOnlyForJa: ReadonlySet<string>;
}

let cached: CharData | null = null;

function charData(): CharData {
  if (cached) return cached;
  const st = parseDict(ST_CHARS);
  const ts = parseDict(TS_CHARS);
  const tw = parseDict(TW_VARIANTS);
  const hk = parseDict(HK_VARIANTS);
  const jp = parseDict(JP_SHINJITAI); // shinjitai -> kyujitai

  const tradSide = charsOf([
    ...st.flatMap(([, d]) => d),
    ...ts.map(([s]) => s),
    ...parseDict(ST_PHRASES).flatMap(([, d]) => d),
    ...tw.flatMap(([s, d]) => [s, ...d]),
    ...hk.flatMap(([s, d]) => [s, ...d]),
  ]);
  const simpSide = charsOf([
    ...ts.flatMap(([, d]) => d),
    ...st.map(([s]) => s),
    ...parseDict(TS_PHRASES).flatMap(([, d]) => d),
  ]);
  const simplifiedOnly = new Set(st.map(([s]) => s).filter((c) => !tradSide.has(c)));
  const traditionalOnly = new Set(ts.map(([s]) => s).filter((c) => !simpSide.has(c)));

  const twMap = new Map(tw.map(([s, d]) => [s, d[0]]));
  const hkMap = new Map(hk.map(([s, d]) => [s, d[0]]));
  const notRegionalForm = new Map([...twMap].filter(([s]) => hkMap.has(s)));
  const notTaiwanForm = new Map([...twMap].filter(([s]) => !hkMap.has(s)));
  const twTargets = new Set(twMap.values());
  // 台 (from 臺), 煙 (from 菸), 濕 (from 溼) and 枱/叁 are normal in Taiwan text too.
  const TW_ALSO = new Set(['台', '煙', '濕', '枱', '叁']);
  const hongKongOnlyForm = new Map(
    [...hkMap].filter(([s, d]) => !twMap.has(s) && !twTargets.has(d) && !TW_ALSO.has(d)).map(([s, d]) => [d, s]),
  );
  const hongKongPrefers = new Map([...hkMap].filter(([s]) => !twMap.has(s) && s !== '臺' && s !== '菸'));

  const shinjitai = new Set(jp.map(([s]) => s));
  const kyujitai = new Map(jp.flatMap(([s, d]) => d.filter((k) => k !== s && !shinjitai.has(k)).map((k) => [k, s] as const)));
  const chineseOnlyForJa = new Set([...simplifiedOnly].filter((c) => !shinjitai.has(c)));

  cached = { simplifiedOnly, traditionalOnly, notTaiwanForm, notRegionalForm, hongKongOnlyForm, hongKongPrefers, kyujitai, chineseOnlyForJa };
  return cached;
}

// ----------------------------------------------------------------------------
// Regional vocabulary (unambiguous pairs only; see docs/i18n/glossary-east-asia.md)
// ----------------------------------------------------------------------------

/** Mainland terms (in Traditional characters) that neither Taiwan nor Hong Kong UI uses. */
const MAINLAND_IN_TRADITIONAL: Readonly<Record<string, string>> = {
  服務器: 'server is 伺服器', 鼠標: 'mouse is 滑鼠', 激活: 'activate is 啟用', 菜單欄: 'menu bar is 選單列',
  截屏: 'screenshot is 截圖',
};

/** Hong Kong (and Mainland) terms Taiwan UI does not use. */
const NOT_TAIWAN: Readonly<Record<string, string>> = {
  軟件: 'Taiwan: 軟體', 網絡: 'Taiwan: 網路', 解像度: 'Taiwan: 解析度', 電單車: 'Taiwan: 機車', 質素: 'Taiwan: 品質',
  屏幕: 'Taiwan: 螢幕', 熒幕: 'Taiwan: 螢幕', 默認: 'Taiwan: 預設', 加載: 'Taiwan: 載入', 視頻: 'Taiwan: 影片',
  菜單: 'Taiwan: 選單', 入油: 'Taiwan: 加油', 油缸: 'Taiwan: 油箱', 打印: 'Taiwan: 列印', 的士: 'Taiwan: 計程車',
  文件夾: 'Taiwan: 資料夾', 信息: 'Taiwan: 訊息 / 資訊',
};

/** Taiwan terms Hong Kong / Macao UI does not use. */
const NOT_HONG_KONG: Readonly<Record<string, string>> = {
  軟體: 'Hong Kong: 軟件', 網路: 'Hong Kong: 網絡', 解析度: 'Hong Kong: 解像度', 機車: 'Hong Kong: 電單車',
  列印: 'Hong Kong: 打印', 計程車: 'Hong Kong: 的士', 腳踏車: 'Hong Kong: 單車', 資料夾: 'Hong Kong: 文件夾',
};

/** Colloquial Cantonese: Hong Kong UI text is standard written Chinese. */
const CANTONESE_COLLOQUIAL = /[嘅咗唔喺嚟啲冇佢睇撳揸嘢俾咩乜嗰]/;

/** Taiwan / Hong Kong terms (in Simplified characters) Mainland and Singapore UI does not use. */
const NOT_MAINLAND: Readonly<Record<string, string>> = {
  软体: 'Mainland: 软件', 网路: 'Mainland: 网络', 萤幕: 'Mainland: 屏幕', 滑鼠: 'Mainland: 鼠标', 伺服器: 'Mainland: 服务器',
  解像度: 'Mainland: 分辨率', 解析度: 'Mainland: 分辨率', 预设值: 'Mainland: 默认值', 资料夹: 'Mainland: 文件夹',
  影格: 'Mainland: 帧', 电单车: 'Mainland: 摩托车', 机车: 'Mainland: 摩托车',
};

// ----------------------------------------------------------------------------
// Checks
// ----------------------------------------------------------------------------

function charIssues(
  key: string, text: string, set: ReadonlySet<string> | ReadonlyMap<string, string>, level: ScriptIssue['level'],
  describe: (c: string, to: string | undefined) => string,
): ScriptIssue[] {
  const found = new Set<string>();
  for (const c of text) if (set.has(c)) found.add(c);
  return [...found].map((c) => ({ key, level, message: describe(c, set instanceof Map ? set.get(c) : undefined) }));
}

function termIssues(key: string, text: string, terms: Readonly<Record<string, string>>, label: string): ScriptIssue[] {
  return Object.keys(terms).filter((term) => text.includes(term)).map((term) => ({
    key, level: 'error' as const, message: `${label} "${term}" (${terms[term]})`,
  }));
}

/**
 * Script, character-form and regional-wording issues of one locale's dictionary. Only the priority
 * locales are checked; other languages return [].
 */
export function scriptIssues(lang: string, dict: StringDict): ScriptIssue[] {
  const d = charData();
  const out: ScriptIssue[] = [];
  for (const [key, text] of Object.entries(dict)) {
    if (typeof text !== 'string') continue;
    switch (lang) {
      case 'zh-CN':
        out.push(...charIssues(key, text, d.traditionalOnly, 'error', (c) => `Traditional character "${c}" in Simplified Chinese`));
        out.push(...termIssues(key, text, NOT_MAINLAND, 'Taiwan / Hong Kong term'));
        break;
      case 'zh-TW':
        out.push(...charIssues(key, text, d.simplifiedOnly, 'error', (c) => `Simplified character "${c}" in Traditional Chinese`));
        out.push(...charIssues(key, text, d.notRegionalForm, 'error', (c, to) => `"${c}" is not a Taiwan form (use "${to}")`));
        out.push(...charIssues(key, text, d.notTaiwanForm, 'error', (c, to) => `"${c}" is not the Taiwan form (use "${to}")`));
        out.push(...charIssues(key, text, d.hongKongOnlyForm, 'error', (c, to) => `"${c}" is a Hong Kong form (Taiwan writes "${to}")`));
        out.push(...termIssues(key, text, NOT_TAIWAN, 'not Taiwan wording:'));
        out.push(...termIssues(key, text, MAINLAND_IN_TRADITIONAL, 'Mainland wording:'));
        break;
      case 'zh-HK':
        out.push(...charIssues(key, text, d.simplifiedOnly, 'error', (c) => `Simplified character "${c}" in Traditional Chinese`));
        out.push(...charIssues(key, text, d.notRegionalForm, 'error', (c, to) => `"${c}" is not a Hong Kong form (use "${to}")`));
        out.push(...charIssues(key, text, d.hongKongPrefers, 'warn', (c, to) => `Hong Kong standard form of "${c}" is "${to}"`));
        out.push(...termIssues(key, text, NOT_HONG_KONG, 'not Hong Kong wording:'));
        out.push(...termIssues(key, text, MAINLAND_IN_TRADITIONAL, 'Mainland wording:'));
        if (CANTONESE_COLLOQUIAL.test(text)) {
          out.push({ key, level: 'error', message: 'colloquial Cantonese; UI text should be standard written Chinese' });
        }
        break;
      case 'ja':
        out.push(...charIssues(key, text, d.chineseOnlyForJa, 'error', (c) => `Chinese simplified character "${c}" in Japanese`));
        out.push(...charIssues(key, text, d.kyujitai, 'error', (c, to) => `"${c}" is not a Japanese form (use "${to}")`));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Exposed for tests: the classification of single characters. */
export function classifyChar(c: string): { simplifiedOnly: boolean; traditionalOnly: boolean; chineseOnlyForJa: boolean } {
  const d = charData();
  return { simplifiedOnly: d.simplifiedOnly.has(c), traditionalOnly: d.traditionalOnly.has(c), chineseOnlyForJa: d.chineseOnlyForJa.has(c) };
}
