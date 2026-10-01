/**
 * server_crawler.ts — 공용 웹 크롤러 / HTML 정제 / 청킹 모듈
 *
 * server.ts 의 수동 크롤 라우트(/api/knowledge-base/crawl)와 자동 재수집(checkAndRunAutoRecrawl)이
 * 이 모듈 하나를 공유한다. (기존에는 크롤러가 두 벌 복제되어 있었음)
 *
 * 주요 동작
 *  - 리다이렉트 추적: 첫 페이지 응답의 최종 URL(response.url) 기준으로 허용 호스트/경로 스코프를 잡고
 *    하위 링크를 해석한다. (docs.nvidia.com/networking/display/... → networking-docs.nvidia.com/... 대응)
 *  - fetch 타임아웃 12초 + 1회 재시도, 정적 파일/첨부(/__attachments/) 제외, 페이지당 300ms 대기
 *  - HTML 정제: <head><title> 만 제목으로 사용(SVG <title> 혼입 방지), 본문 선택자 우선순위 적용
 *    (main → article → … → body), 표를 '| a | b |' 행으로 변환, 버전 목록/네비 노이즈 제거
 *  - 청킹: 헤딩(#, ##, ###) 기준으로 섹션을 나누고 목표 2,500자(최대 4,000자)로 분할.
 *    각 청크는 독립된 지식베이스 문서가 되며 id 는 pageUrl 해시 기반으로 안정적 (재수집 시 동일 id 로 갱신)
 */

import * as cheerio from "cheerio";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CrawlLogType = "start" | "progress" | "warning" | "saved" | "complete" | "error";
export type CrawlLogger = (message: string, type?: CrawlLogType, extra?: Record<string, any>) => void;

export interface CrawlOptions {
  startUrl: string;
  maxPages?: number;          // default 50, cap 300
  maxDepth?: number;          // default 2, cap 6
  category?: string;
  log?: CrawlLogger;
  fetchTimeoutMs?: number;    // default 12000
  politenessMs?: number;      // default 300
  chunkTargetChars?: number;  // default 2500
  chunkMaxChars?: number;     // default 4000
}

export interface CrawledChunkDoc {
  id: string;
  title: string;
  category: string;
  tags: string[];
  sourceUrl: string;   // 페이지 최종 URL (+ 청크가 여러 개면 #chunk-N)
  pageUrl: string;     // 페이지 최종 URL
  pageTitle: string;
  heading: string;
  crawlRoot: string;   // 사용자가 등록한 소스 URL (정규화된 href)
  chunkIndex: number;
  chunkCount: number;
  depth: number;
  content: string;
  updatedAt: string;
}

export interface CrawlResult {
  crawlRoot: string;
  scopeOrigin: string;
  scopePath: string;
  pagesAttempted: number;
  pagesSaved: number;
  chunks: CrawledChunkDoc[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CRAWL_MAX_PAGES_CAP = 300;
export const CRAWL_MAX_DEPTH_CAP = 6;

const STATIC_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".tar", ".gz", ".tgz", ".exe", ".dmg", ".msi",
  ".mp4", ".mp3", ".css", ".js", ".mjs", ".json", ".xml", ".svg", ".avi", ".ico", ".woff", ".woff2", ".ttf", ".rss", ".atom",
];

const REMOVE_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg", "canvas", "template",
  "nav", "footer", "header", "head", "select", "option", "button", "form", "input", "textarea",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='search']", "[aria-hidden='true']",
  ".header", ".footer", ".nav", ".navbar", ".navigation", ".sidebar", "#sidebar", ".menu", "#menu", ".banner", ".ads",
  ".wy-nav-side", ".wy-side-scroll", ".wy-breadcrumbs", ".rst-versions", ".md-sidebar", ".md-nav", ".md-header", ".md-tabs",
  ".toc", ".table-of-contents", ".version-switcher", ".version-picker", ".picker", "[class*='version-switch']",
  ".dropdown", ".copyright", ".feedback-section", ".pagination", ".page-nav", ".page-pagination", ".skip-link",
  "a[href='#main-content']", "a[href='#content']", ".layout-top", ".search-container", ".search-box", ".breadcrumbs", ".breadcrumb",
  ".drawer", ".drawer-section", ".navigator", ".navigator-body", ".td-sidebar", ".td-sidebar-nav", ".td-toc", ".td-navbar", ".td-footer",
  ".theme-doc-sidebar-container", ".theme-doc-toc-desktop", ".pagination-nav", ".cookie-banner", "#onetrust-consent-sdk",
];

// 우선순위대로 하나씩 시도 — 기존 코드의 $("main, article, ..., body").first() 는 문서 순서상 body 가 항상 선택되는 버그가 있었다
const CONTENT_SELECTORS = [
  "main article", "article", "main", "[role='main']", ".td-content", ".rst-content", ".markdown-section", ".theme-doc-markdown",
  ".document", ".content", "#content", "#main-content", "body",
];

const LINE_NOISE_PATTERNS: RegExp[] = [
  /^skip to main content$/i,
  /^breadcrumbs?$/i,
  /^main navigation$/i,
  /^close navigation$/i,
  /^on this page$/i,
  /^pagination$/i,
  /^main$/i,
  /^(auto|light|dark|color mode)$/i,
  /^go to homepage$/i,
  /^download pdf$/i,
  /^chevron_right$/i,
  /^was this page helpful\??$/i,
  /^last updated:?\s/i,
  /^copyright/i,
  /^powered by/i,
  /^all rights reserved/i,
  /^document revision history$/i,
  /^v?\d+\.\d+(\.\d+)*(\s*LTS.*)?$/i,          // 버전 목록 한 줄 (3.12.5000, 3.11.2600 LTS (2023 LTS U6) ...)
  /^v\d+\.\d+v\d+\.\d+/i,
  /^(next page|previous page)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeUrlKey(u: string): string {
  return (u || "").toLowerCase().trim().replace(/\/+$/, "");
}

export function stableId(input: string, len = 12): string {
  return createHash("sha1").update(input).digest("hex").slice(0, len);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(targetUrl: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithRetry(targetUrl: string, timeoutMs: number, log?: CrawlLogger): Promise<{ response: Response; html: string } | null> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchWithTimeout(targetUrl, timeoutMs);
      if (response.status >= 500 && attempt === 1) {
        lastErr = new Error(`HTTP ${response.status}`);
        await sleep(1000);
        continue;
      }
      if (!response.ok) {
        log?.(`⚠️ HTTP error ${response.status} fetching ${targetUrl}. Skipping.`, "warning");
        return null;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/html")) {
        log?.(`⚠️ Skipped non-HTML contentType (${contentType}) at ${targetUrl}`, "warning");
        return null;
      }
      const html = await response.text();
      return { response, html };
    } catch (err: any) {
      lastErr = err;
      if (attempt === 1) {
        log?.(`⏳ Retry after error on ${targetUrl}: ${err?.name === "AbortError" ? "timeout" : (err?.message || err)}`, "progress");
        await sleep(1000);
      }
    }
  }
  log?.(`❌ Error crawling ${targetUrl}: ${lastErr?.name === "AbortError" ? "timeout" : (lastErr?.message || "Unknown Network Error")}`, "warning");
  return null;
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

export function cleanHtmlContent(rawHtml: string, pageUrl: string): { title: string; content: string; childHrefs: string[] } {
  const $ = cheerio.load(rawHtml);

  // 1. 링크는 네비 제거 전에 수집 (페이지 트리/목차 링크가 곧 하위 페이지)
  const childHrefs: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) childHrefs.push(href);
  });

  // 2. 제목: <head><title> 만 사용 (SVG 아이콘의 <title> 이 섞이던 문제 방지)
  let title = $("head > title").first().text().trim();
  if (!title) title = $("title").first().text().trim();
  if (!title) title = $("h1").first().text().trim();
  if (!title) title = pageUrl.replace(/^https?:\/\//i, "");
  title = title.replace(/\s+/g, " ").trim();

  // 3. 노이즈 요소 제거
  $(REMOVE_SELECTORS.join(", ")).remove();

  // 4. 구조 보존 변환: 표 → '| a | b |', 헤딩 → #, 코드 → ```, 목록 → -
  $("table").each((_, table) => {
    const rows: string[] = [];
    $(table).find("tr").each((__, tr) => {
      const cells: string[] = [];
      $(tr).find("th, td").each((___, cell) => {
        cells.push($(cell).text().replace(/\s+/g, " ").trim());
      });
      if (cells.some((c) => c)) rows.push(`| ${cells.join(" | ")} |`);
    });
    $(table).replaceWith(rows.length ? `\n\n${rows.join("\n")}\n\n` : "");
  });
  $("h1").each((_, el) => { $(el).replaceWith(`\n\n# ${$(el).text().replace(/\s+/g, " ").trim()}\n\n`); });
  $("h2").each((_, el) => { $(el).replaceWith(`\n\n## ${$(el).text().replace(/\s+/g, " ").trim()}\n\n`); });
  $("h3, h4, h5, h6").each((_, el) => { $(el).replaceWith(`\n\n### ${$(el).text().replace(/\s+/g, " ").trim()}\n\n`); });
  $("pre").each((_, el) => {
    const codeText = $(el).text().replace(/\s+$/, "");
    $(el).replaceWith(`\n\n\`\`\`\n${codeText}\n\`\`\`\n\n`);
  });
  $("code").each((_, el) => {
    const codeText = $(el).text().trim();
    $(el).replaceWith(codeText.includes("\n") ? `\n\`\`\`\n${codeText}\n\`\`\`\n` : `\`${codeText}\``);
  });
  $("li").each((_, el) => { $(el).replaceWith(`\n- ${$(el).text().replace(/\s+/g, " ").trim()}`); });
  $("p, div, section, blockquote, dd, dt").each((_, el) => { $(el).prepend("\n"); $(el).append("\n"); });
  $("br").replaceWith("\n");

  // 5. 본문 컨테이너 선택 (우선순위, 최소 길이 200자)
  let mainText = "";
  for (const sel of CONTENT_SELECTORS) {
    const node = $(sel).first();
    if (node.length === 0) continue;
    const text = node.text();
    if (text.replace(/\s+/g, "").length >= 200 || sel === "body") {
      mainText = text;
      break;
    }
  }
  if (!mainText) mainText = $("body").text() || $.root().text();

  // 6. 줄 단위 정리
  const lines = mainText.split(/\r?\n/);
  const cleanLines: string[] = [];
  let inCode = false;
  for (const rawLine of lines) {
    const line = inCode ? rawLine.replace(/\s+$/, "") : rawLine.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      cleanLines.push("```");
      continue;
    }
    if (inCode) {
      cleanLines.push(line);
      continue;
    }
    if (!line) {
      if (cleanLines.length && cleanLines[cleanLines.length - 1] !== "") cleanLines.push("");
      continue;
    }
    if (LINE_NOISE_PATTERNS.some((p) => p.test(line))) continue;
    cleanLines.push(line);
  }

  let content = cleanLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (content.length > 60000) {
    content = content.substring(0, 60000) + "\n\n...[지식 보관소 한도로 데이터 축약됨]";
  }
  return { title, content, childHrefs };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface TextChunk { heading: string; text: string; }

/**
 * 헤딩 기준 섹션 분할 → 목표 길이로 병합/분할.
 *  - '# ', '## ', '### ' 로 시작하는 줄에서 새 섹션 시작
 *  - 코드블록(```) 내부는 분리하지 않음
 *  - minChars 미만 섹션은 앞 섹션에 병합, maxChars 초과 섹션은 문단 단위로 분할
 */
export function chunkDocument(content: string, targetChars = 2500, maxChars = 4000, minChars = 400): TextChunk[] {
  const text = (content || "").trim();
  if (!text) return [];
  if (text.length <= maxChars) return [{ heading: "", text }];

  // 1) 섹션 분할
  const sections: TextChunk[] = [];
  let current: TextChunk = { heading: "", text: "" };
  let inCode = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    const isHeading = !inCode && /^#{1,3} /.test(line);
    if (isHeading && current.text.trim()) {
      sections.push(current);
      current = { heading: line.replace(/^#{1,3} /, "").trim(), text: "" };
    } else if (isHeading) {
      current.heading = line.replace(/^#{1,3} /, "").trim();
    }
    current.text += (current.text ? "\n" : "") + line;
  }
  if (current.text.trim()) sections.push(current);

  // 2) 작은 섹션 병합
  const merged: TextChunk[] = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && (s.text.length < minChars || last.text.length < minChars) && last.text.length + s.text.length <= targetChars) {
      // 병합 시 더 긴 쪽(실질 내용)의 헤딩을 대표 헤딩으로 사용
      if (!last.heading || (s.heading && s.text.length > last.text.length)) last.heading = s.heading;
      last.text += "\n\n" + s.text;
    } else {
      merged.push({ heading: s.heading, text: s.text });
    }
  }

  // 3) 큰 섹션 분할 (문단 단위, 코드블록 보존)
  const out: TextChunk[] = [];
  for (const s of merged) {
    if (s.text.length <= maxChars) { out.push(s); continue; }
    const paras = splitParagraphsKeepingCode(s.text);
    let buf = "";
    let part = 0;
    for (const p of paras) {
      if (buf && buf.length + p.length + 2 > targetChars) {
        out.push({ heading: part === 0 ? s.heading : `${s.heading} (계속 ${part + 1})`, text: buf });
        part++;
        buf = "";
      }
      if (p.length > maxChars) {
        // 단일 문단이 너무 길면 강제 분할
        for (let i = 0; i < p.length; i += targetChars) {
          const piece = p.slice(i, i + targetChars);
          out.push({ heading: part === 0 ? s.heading : `${s.heading} (계속 ${part + 1})`, text: (buf ? buf + "\n\n" : "") + piece });
          buf = "";
          part++;
        }
        continue;
      }
      buf = buf ? buf + "\n\n" + p : p;
    }
    if (buf) out.push({ heading: part === 0 ? s.heading : `${s.heading} (계속 ${part + 1})`, text: buf });
  }
  return out.filter((c) => c.text.trim().length > 0);
}

function splitParagraphsKeepingCode(text: string): string[] {
  const paras: string[] = [];
  let buf = "";
  let inCode = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      buf += (buf ? "\n" : "") + line;
      if (!inCode) { paras.push(buf); buf = ""; }
      continue;
    }
    if (inCode) { buf += "\n" + line; continue; }
    if (!line.trim()) {
      if (buf) { paras.push(buf); buf = ""; }
      continue;
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) paras.push(buf);
  return paras;
}

// ---------------------------------------------------------------------------
// Auto tags (기존 로직 유지)
// ---------------------------------------------------------------------------

const TECH_TAGS: { key: string; matches: string[] }[] = [
  { key: "ufm", matches: ["ufm", "unified fabric manager", "ufm-sdn", "nvidia-sm"] },
  { key: "lacp", matches: ["lacp", "bonding", "cl-net", "bond"] },
  { key: "bonding", matches: ["bonding", "bond", "lacp"] },
  { key: "bridge", matches: ["bridge", "vlan bridge", "브릿지", "브리지"] },
  { key: "vlan", matches: ["vlan", "vlans"] },
  { key: "vxlan", matches: ["vxlan", "vxlans", "evpn"] },
  { key: "cumulus", matches: ["cumulus", "큐물러스", "nvue"] },
  { key: "infiniband", matches: ["infiniband", "인피니밴드", "mellanox", "hca"] },
  { key: "opensm", matches: ["opensm", "subnet manager"] },
  { key: "mstflint", matches: ["mstflint", "펌웨어", "firmware"] },
  { key: "guid", matches: ["guid", "hca", "어댑터"] },
  { key: "ibstat", matches: ["ibstat", "ibnetdiscover"] },
  { key: "mlnx-os", matches: ["mlnx-os", "mlnxos", "onyx"] },
  { key: "nvidia", matches: ["nvidia", "mellanox"] },
];

export function autoTagsFor(title: string, text: string, hostname: string): string[] {
  const combined = `${title} ${text}`.toLowerCase();
  const tags = ["crawled", hostname];
  for (const t of TECH_TAGS) {
    if (t.matches.some((m) => combined.includes(m)) && !tags.includes(t.key)) tags.push(t.key);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

function isInScope(resolved: URL, scope: URL): boolean {
  const startPath = scope.pathname.toLowerCase().replace(/\/+$/, "");
  const resolvedPath = resolved.pathname.toLowerCase().replace(/\/+$/, "");
  if (!startPath || startPath === "/") return true;
  if (resolvedPath === startPath || resolvedPath.startsWith(startPath + "/")) return true;
  // 형제 섹션 허용: 시작 경로의 부모 아래 (예: /manual/version/section 에서 /manual/version/other-section)
  const lastSlash = startPath.lastIndexOf("/");
  if (lastSlash > 0) {
    const parentPath = startPath.substring(0, lastSlash);
    if (parentPath.length > 5 && (resolvedPath === parentPath || resolvedPath.startsWith(parentPath + "/"))) return true;
  }
  return false;
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const log: CrawlLogger = opts.log || ((m) => console.log(`[Crawler] ${m}`));
  const maxPages = Math.min(Math.max(opts.maxPages || 50, 1), CRAWL_MAX_PAGES_CAP);
  const maxDepth = Math.min(Math.max(opts.maxDepth || 2, 1), CRAWL_MAX_DEPTH_CAP);
  const category = (opts.category || "Crawled Web").trim();
  const timeoutMs = opts.fetchTimeoutMs ?? 12000;
  const politeness = opts.politenessMs ?? 300;
  const chunkTarget = opts.chunkTargetChars ?? 2500;
  const chunkMax = opts.chunkMaxChars ?? 4000;

  let resolvedUrl = opts.startUrl.trim();
  if (!/^https?:\/\//i.test(resolvedUrl)) resolvedUrl = "https://" + resolvedUrl;
  const startUrlObj = new URL(resolvedUrl);
  const crawlRoot = startUrlObj.href;

  // 리다이렉트되면 첫 페이지 응답으로 갱신
  let scope = new URL(startUrlObj.href);
  let scopeResolved = false;

  const queue: { url: string; depth: number }[] = [{ url: startUrlObj.href, depth: 1 }];
  const visited = new Set<string>();
  const chunks: CrawledChunkDoc[] = [];
  const errors: string[] = [];
  let pagesAttempted = 0;
  let pagesSaved = 0;
  const now = new Date().toISOString();

  while (queue.length > 0 && pagesAttempted < maxPages) {
    const current = queue.shift()!;
    if (visited.has(current.url)) continue;
    visited.add(current.url);
    pagesAttempted++;
    log(`➡️ Fetching level ${current.depth} URL [${pagesAttempted}/${maxPages}]: ${current.url}`, "progress");

    try {
      if (politeness > 0) await sleep(politeness);
      const fetched = await fetchHtmlWithRetry(current.url, timeoutMs, log);
      if (!fetched) { errors.push(current.url); continue; }
      const { response, html } = fetched;

      const finalUrl = (response.url && response.url !== current.url) ? response.url : current.url;
      if (finalUrl !== current.url) {
        if (visited.has(finalUrl)) { log(`↪ Redirected to already-visited ${finalUrl}. Skipping.`, "progress"); continue; }
        visited.add(finalUrl);
        log(`   ↪ Redirected to ${finalUrl}`, "progress");
      }
      if (!scopeResolved) {
        scopeResolved = true;
        const finalObj = new URL(finalUrl);
        if (finalObj.hostname !== scope.hostname || normalizeUrlKey(finalObj.pathname) !== normalizeUrlKey(scope.pathname)) {
          scope = finalObj;
          log(`   🔁 Crawl scope moved to redirected location: ${finalObj.origin}${finalObj.pathname}`, "progress");
        }
      }

      const { title: pageTitle, content, childHrefs } = cleanHtmlContent(html, finalUrl);

      // 하위 링크 큐잉
      if (current.depth < maxDepth) {
        let added = 0;
        for (const href of childHrefs) {
          try {
            const resolved = new URL(href, finalUrl);
            if (resolved.hostname !== scope.hostname) continue;
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
            resolved.hash = "";
            resolved.search = ""; // 쿼리 변형 중복 제거 (문서 사이트에서는 대부분 불필요)
            const clean = resolved.href;
            const path = resolved.pathname.toLowerCase();
            if (STATIC_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
            if (path.includes("/__attachments/") || path.includes("/attachments/") || path.includes("/__theme/")) continue;
            if (!isInScope(resolved, scope)) continue;
            if (visited.has(clean) || queue.some((q) => q.url === clean)) continue;
            queue.push({ url: clean, depth: current.depth + 1 });
            added++;
          } catch {
            // ignore malformed
          }
        }
        if (added > 0) log(`   Found ${added} new sub-URLs in scope added to queue (queue: ${queue.length}).`, "progress");
      }

      // 섹션 목차만 있는 인덱스 페이지(하위 링크 나열)는 저장 가치가 없으므로 건너뛴다 (링크 큐잉은 위에서 이미 완료)
      if (content.length < 150) {
        log(`⚠️ Content on ${finalUrl} is an index/empty page (${content.length} chars). Links queued, storage skipped.`, "progress");
        continue;
      }

      // 청킹 → 문서 생성
      const pieces = chunkDocument(content, chunkTarget, chunkMax);
      const pageHash = stableId(normalizeUrlKey(finalUrl));
      const tags = autoTagsFor(pageTitle, content, scope.hostname);
      const total = pieces.length;
      pieces.forEach((piece, idx) => {
        const headingLabel = piece.heading && piece.heading !== pageTitle ? ` › ${piece.heading}` : "";
        const multi = total > 1 ? ` (${idx + 1}/${total})` : "";
        const contextHeader = `[출처 URL: ${finalUrl}]\n[크롤링 수준: Depth ${current.depth}]\n[페이지: ${pageTitle}${piece.heading ? ` / 섹션: ${piece.heading}` : ""}]\n\n`;
        chunks.push({
          id: `kb_crawl_${pageHash}_c${idx}`,
          title: `[웹사이트] ${pageTitle}${headingLabel}${multi}`,
          category,
          tags,
          sourceUrl: total > 1 ? `${finalUrl}#chunk-${idx + 1}` : finalUrl,
          pageUrl: finalUrl,
          pageTitle,
          heading: piece.heading || "",
          crawlRoot,
          chunkIndex: idx,
          chunkCount: total,
          depth: current.depth,
          content: contextHeader + piece.text,
          updatedAt: now,
        });
      });
      pagesSaved++;
      log(`✅ Saved: "${pageTitle}" (${content.length} chars → ${total} chunk${total > 1 ? "s" : ""})`, "saved", { url: finalUrl, title: pageTitle, chunks: total });
    } catch (err: any) {
      errors.push(current.url);
      log(`❌ Error crawling ${current.url}: ${err?.message || "Unknown error"}`, "warning");
    }
  }

  return {
    crawlRoot,
    scopeOrigin: scope.origin,
    scopePath: scope.pathname,
    pagesAttempted,
    pagesSaved,
    chunks,
    errors,
  };
}

/** 특정 소스(crawlRoot)에 속한 문서인지 판정. 레거시 문서(crawlRoot 없음)는 sourceUrl 정확 일치 또는 [출처 URL] 접두 일치로 판정 */
export function docBelongsToSource(doc: any, sourceUrl: string): boolean {
  if (!doc || !doc.id || !String(doc.id).startsWith("kb_crawl_")) return false;
  const key = normalizeUrlKey(sourceUrl);
  if (doc.crawlRoot) return normalizeUrlKey(doc.crawlRoot) === key;
  if (doc.sourceUrl) {
    const k = normalizeUrlKey(String(doc.sourceUrl).split("#")[0]);
    if (k === key) return true;
  }
  if (doc.content) {
    const m = String(doc.content).match(/\[출처 URL: ([^\]]+)\]/);
    if (m && m[1]) {
      const k = normalizeUrlKey(m[1]);
      return k === key || k.startsWith(key + "/");
    }
  }
  return false;
}
