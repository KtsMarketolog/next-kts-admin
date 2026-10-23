import { createHash } from 'node:crypto';

/** Reviewed author-script profiles. Embedded JSON/business data is neither hashed nor copied here.
 * Offsets delimit the synchronous render body in that exact script. Unknown versions keep the
 * generic adapter; they never receive guessed calculation hooks or changed report logic.
 */
export type DashboardUsageProfile = {
  id: string;
  tabs: string;
  filterClicks: string;
  filterInputs: string;
  calculationClicks?: string;
  calculationInputs?: string;
};
type ReviewedProfile = DashboardUsageProfile & {
  sha256: string; bodyStart: number; bodyEnd: number; calculated: string; caughtFailure?: string;
  extraBodies?: Array<{bodyStart: number; bodyEnd: number; calculated: string}>;
};
const PROFILES: readonly ReviewedProfile[] = [
  {
    id: 'personal-sales-v34', sha256: '232a86699be1ef4bc09dbaf14d5301fd593e8fc6a26ac3b08553bc47ae99b168',
    bodyStart: 21082, bodyEnd: 22754, calculated: 'Boolean(D && D.rows && D.rows.length)',
    tabs: 'nav button[onclick^="U.tab="]',
    filterClicks: '[data-set],[data-msclr],.pbar .reset,[onclick^="GOODS_KEYS."],[onclick^="U.goodsDim="],[onclick^="U.yoyDim="],[onclick^="U.kpDim="],[onclick^="U.kpZone"],[onclick^="setRole("]',
    filterInputs: 'input[data-msk],input.srch,input[oninput^="U.potQ="]',
  },
  {
    id: 'sales-analytics-v98', sha256: 'a3d7dab220e8a3f10e133df85798f8d0e08f83feb0737eada48da6097fc9e014',
    bodyStart: 78873, bodyEnd: 81074, calculated: 'Boolean(S.raw.length)', caughtFailure: '} catch (err){',
    tabs: 'button[data-tab]:not(.nav-act)',
    filterClicks: '.yr,.resetf,[onclick^="clearMulti("],[onclick^="clearQuick("],[onclick="S.cdrill=null;render()"]',
    filterInputs: '#fFrom,#fTo,#fQ,#gran,#multis input[type="checkbox"],[onchange^="S.opts."]',
  },
  {
    id: 'assortment-v96', sha256: '344457845fa6cb582ae6d135e1f2f996fdd555b9cfd60f747e142080213edea4',
    bodyStart: 214903, bodyEnd: 215674, calculated: 'Boolean(S.raw.length)',
    tabs: '[onclick^="setView("]',
    filterClicks: '[onclick^="tglYear("],[onclick^="tglQ("],[onclick^="clearQuick("],[onclick^="gfResetAll("],[onclick^="gfClear("],[onclick^="gfMark("],[onclick^="clearFilt("],[onclick^="multiApply("],[onclick^="setThr("]',
    filterInputs: '#fFrom,#fTo,[onchange^="gfSet("],[oninput^="filtTable("],[onchange^="filtTable("]',
    calculationInputs: '[onchange^="S.leadDays="],[onchange^="S.safetyMon="],[onchange^="S.lotMon="],[onchange^="S.ordBasis="]',
  },
  {
    id: 'purchases-v55', sha256: '0234d67db32959f5094f2de9d62600aed7d4e2a4564e9ebe1e2016103fc8c489',
    bodyStart: 248869, bodyEnd: 258518, calculated: 'Boolean(hasAnyData() && state.tab !== "load")',
    tabs: 'button[data-tab],[data-go]',
    filterClicks: '[data-msv],[data-msall],[data-msnone],[data-clear],[data-clear2],[data-clear-all],[data-clidir],[data-chdir],[data-cut],[data-cutv],[data-auth],[data-art]',
    filterInputs: 'select[id^="f"],#fOrdSearch,#fChainSearch,#fPaySearch',
    calculationInputs: '#fVatKey,#fVatSpread,#fVatDays',
  },
  {
    id: 'strategy-v24', sha256: '8c560255e7fdde949d57fbee742cf450fdf3daf8bb751e2d1e5730bf7f33116a',
    bodyStart: 81607, bodyEnd: 91931, calculated: 'Boolean(D.rows.length && D.view !== "load")',
    tabs: '[data-view]',
    filterClicks: '[data-py],[data-pq],[data-pm],[data-prst],[data-role],[data-cut]',
    filterInputs: '#pf,#pt,#sparkVat',
  },
  {
    id: 'route-planner-v26', sha256: 'd2f8c8f0519e3eea88158e9ae40a1f5b1d2cd49d5d16e2b0df70fb5de284575a',
    bodyStart: 106032, bodyEnd: 106876, calculated: 'Boolean(S.docs.length && S.sec !== "data")',
    tabs: '#nav a[onclick^="UI.go("]',
    filterClicks: '[onclick^="UI.today("],[onclick^="UI.reset("],[onclick^="UI.msAll("],[onclick^="UI.tfClear("]',
    filterInputs: '[onchange^="UI.per("],[onchange^="UI.perOrd("],[onchange^="UI.msPick("],[onchange^="UI.setConf("],[oninput^="UI.tf("],[onchange^="UI.tf("]',
    calculationInputs: '[onchange^="UI.opt("],[oninput^="UI.opt("],[onchange^="UI.wind("],[onchange^="UI.rate("],[onchange^="UI.zone("]',
  },
  {
    id: 'profitability-v19', sha256: 'e58f2d053f9edc76217a13e1a3d8ec89bd8e2493604ef00786d70b656d6e9b84',
    bodyStart: 134630, bodyEnd: 135328, calculated: 'Boolean(S.invs.length && (S.view === "sum" || S.view.startsWith("inv:")))',
    extraBodies: [
      {bodyStart:132706,bodyEnd:133976,calculated:'Boolean(S.invs.length)'},
      {bodyStart:226081,bodyEnd:226327,calculated:'Boolean(S.invs.length && S.view === "sum")'},
    ],
    tabs: '.mitem[data-view],button[data-view]',
    filterClicks: '[data-exp-inv],#bExpAll,#bColAll',
    filterInputs: '#nomQ',
    calculationClicks: '[data-fxd],#bFxReset,#bRateReset,#bPriceReset,#bPctAll,[data-iv],#pickCostOk,#pickCostClr,#pickNone',
    calculationInputs: '[data-fxc],#selCur,#inpRate,[data-ml],[data-mp],.xrow [data-f="val"],.xrow [data-f="unit"],.xrow [data-f="withVat"],.xrow [data-f="method"]',
  },
];

/** Compiled templates keep an inert copy for existing reviewed UI selectors.
 * This expands only selectors, never calculation hooks or profile fingerprints. */
export function withCompiledDashboardHandlerSelectors(selector: string): string {
  const compiled = selector.replace(/\[(on[a-z]+)(?=[~|^$*]?=)/g, '[data-kts-handler-$1');
  return compiled === selector ? selector : `${selector},${compiled}`;
}

function instrument(html: string, profitability: boolean): string {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag: string, attributes: string, source: string) => {
    if (attributes.trim()) return tag;
    const hash = createHash('sha256').update(source, 'utf8').digest('hex');
    const profile = PROFILES.find((candidate) => candidate.sha256 === hash);
    if (!profile || (profile.id === 'profitability-v19') !== profitability) return tag;
    const bodies = [profile, ...(profile.extraBodies ?? [])].sort((left,right)=>right.bodyStart-left.bodyStart);
    if (bodies.some(body=>source[body.bodyStart] !== '{' || source[body.bodyEnd-1] !== '}')) return tag;
    let patched = source;
    // Keep original return/throw, this and arguments semantics; only a completed render can ACK an intent.
    // The sales renderer catches its own calculation errors, so its error branch explicitly suppresses ACK.
    for (const range of bodies) {
      let body = source.slice(range.bodyStart + 1, range.bodyEnd - 1);
      if (range === profile && profile.caughtFailure) {
        if (body.split(profile.caughtFailure).length !== 2) return tag;
        body = body.replace(profile.caughtFailure, profile.caughtFailure + '\n__ktsUsageFailed = true;');
      }
      const instrumented = `{\nconst __ktsUsageDone = window.__ktsDashboardUsage?.beginRender();\nlet __ktsUsageFailed = false;\nconst __ktsUsageResult = (function(){${body}\n}).apply(this, arguments);\nif (!__ktsUsageFailed) __ktsUsageDone?.(${range.calculated});\nreturn __ktsUsageResult;\n}`;
      patched = patched.slice(0,range.bodyStart) + instrumented + patched.slice(range.bodyEnd);
    }
    const configuration: DashboardUsageProfile = { id: profile.id,
      tabs: withCompiledDashboardHandlerSelectors(profile.tabs),
      filterClicks: withCompiledDashboardHandlerSelectors(profile.filterClicks),
      filterInputs: withCompiledDashboardHandlerSelectors(profile.filterInputs),
      calculationClicks: profile.calculationClicks && withCompiledDashboardHandlerSelectors(profile.calculationClicks),
      calculationInputs: profile.calculationInputs && withCompiledDashboardHandlerSelectors(profile.calculationInputs) };
    const setup = `(()=>{const configure=()=>window.__ktsDashboardUsage?.configure(${JSON.stringify(configuration).replace(/</g, '\\u003c')});configure();document.addEventListener('DOMContentLoaded',configure,{once:true});})();\n`;
    // Keep the author's directive prologue (notably "use strict") first. The
    // initial render is not user activity; configure after application startup.
    return `<script>${patched}\n;${setup}</script>`;
  });
}

export function instrumentReviewedDashboardUsage(html: string): string { return instrument(html, false); }
// Apply only inside the opt-in invoice adapter, after its unmodified-HTML
// fingerprint check. Generic TOP injection must not interfere with that check.
export function instrumentReviewedProfitabilityUsage(html: string): string { return instrument(html, true); }
