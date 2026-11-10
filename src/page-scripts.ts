/**
 * Functions in this file run inside the page. Playwright serializes the
 * function source, so each one must be self-contained: no imports, no
 * references to module-level helpers.
 */

export interface ControlInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  states: string[];
  box?: { x: number; y: number; width: number; height: number };
}

export interface SnapshotData {
  url: string;
  title: string;
  controls: ControlInfo[];
  totalControls: number;
  text: string;
  textTruncated: boolean;
}

export function snapshotPage(args: { maxControls: number; maxText: number }): SnapshotData {
  const w = window as any;
  // Refs are stable for as long as the element stays connected. A new snapshot
  // does not renumber existing controls, so an agent can safely use a ref it
  // learned earlier even when a diff omits unchanged elements.
  let refs: Map<string, Element> = w.__bmRefs;
  if (!(refs instanceof Map)) {
    refs = new Map<string, Element>();
    w.__bmRefs = refs;
  }
  let refIds: WeakMap<Element, string> = w.__bmRefIds;
  if (!(refIds instanceof WeakMap)) {
    refIds = new WeakMap<Element, string>();
    w.__bmRefIds = refIds;
  }
  for (const [id, element] of [...refs]) {
    if (!element.isConnected) refs.delete(id);
  }
  let seq = typeof w.__bmRefSeq === "number" ? w.__bmRefSeq : 0;

  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const isVisible = (el: Element): boolean => {
    if (!el.isConnected) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    const check = (el as any).checkVisibility;
    if (typeof check === "function") {
      try {
        if (!check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch {
        // fall through to the manual checks
      }
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const textOf = (el: Element): string => {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      return norm((el as HTMLInputElement).value);
    }
    if (tag === "SELECT") {
      return norm((el as HTMLSelectElement).selectedOptions?.[0]?.textContent ?? "");
    }
    return norm((el as HTMLElement).innerText ?? el.textContent ?? "");
  };

  const labelFor = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id) {
      const escaped = (window as any).CSS?.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
      const label = document.querySelector(`label[for="${escaped}"]`);
      if (label) return norm(label.textContent);
    }
    const wrapping = el.closest("label");
    return wrapping ? norm(wrapping.textContent) : "";
  };

  const accessibleName = (el: Element): string => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => norm(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const ariaLabel = norm(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const label = labelFor(el);
    if (label) return label;

    const tag = el.tagName;
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      const type = (input.type || "text").toLowerCase();
      if (["submit", "button", "reset"].includes(type)) return norm(input.value) || type;
      if (input.placeholder) return norm(input.placeholder);
      if (type === "image") return norm(input.alt) || "image";
    }
    if (tag === "TEXTAREA" && (el as HTMLTextAreaElement).placeholder) {
      return norm((el as HTMLTextAreaElement).placeholder);
    }
    if (tag === "IMG") return norm(el.getAttribute("alt")) || norm(el.getAttribute("title"));

    const alt = norm(el.getAttribute("alt"));
    if (alt) return alt;
    const title = norm(el.getAttribute("title"));
    if (title) return title;

    const text = textOf(el);
    if (text) return text.slice(0, 120);

    return norm(el.getAttribute("name")) || el.tagName.toLowerCase();
  };

  const roleOf = (el: Element): string => {
    const explicit = norm(el.getAttribute("role"));
    if (explicit) return explicit.split(/\s+/)[0]!;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "text";
    if (tag === "BUTTON") return "button";
    if (tag === "SELECT") return el.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      switch ((input.type || "text").toLowerCase()) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "range":
          return "slider";
        case "number":
          return "spinbutton";
        case "search":
          return "searchbox";
        case "submit":
        case "button":
        case "reset":
        case "image":
          return "button";
        case "file":
          return "button";
        default:
          return "textbox";
      }
    }
    if (el.tagName === "SUMMARY") return "disclosure";
    if (el.hasAttribute("contenteditable")) return "textbox";
    return el.tagName.toLowerCase();
  };

  const statesOf = (el: Element): string[] => {
    const states: string[] = [];
    const elAny = el as any;
    if (elAny.disabled === true || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (elAny.readOnly === true) states.push("readonly");
    if (elAny.required === true || el.getAttribute("aria-required") === "true") states.push("required");
    if (elAny.checked === true || el.getAttribute("aria-checked") === "true") states.push("checked");
    if (elAny.selected === true) states.push("selected");
    if (elAny.multiple === true) states.push("multiple");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") states.push("expanded");
    if (expanded === "false") states.push("collapsed");
    if (el.getAttribute("aria-pressed") === "true") states.push("pressed");
    if (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") {
      states.push("current");
    }
    if (elAny.type === "password") states.push("password");
    return states;
  };

  const valueOf = (el: Element): string | undefined => {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      const type = (input.type || "text").toLowerCase();
      if (type === "password") return input.value ? "•".repeat(Math.min(input.value.length, 16)) : "";
      if (["checkbox", "radio"].includes(type)) return undefined;
      if (type === "file") return input.files?.length ? `${input.files.length} file(s)` : "";
      return input.value ? norm(input.value).slice(0, 160) : undefined;
    }
    if (tag === "TEXTAREA") {
      const value = (el as HTMLTextAreaElement).value;
      return value ? norm(value).slice(0, 160) : undefined;
    }
    if (tag === "SELECT") {
      return norm((el as HTMLSelectElement).selectedOptions?.[0]?.textContent ?? "") || undefined;
    }
    return undefined;
  };

  const selector =
    'a[href], button, input, select, textarea, summary, [role], [contenteditable=""], ' +
    '[contenteditable="true"], [tabindex]:not([tabindex="-1"]), [onclick]';

  const candidates = Array.from(document.querySelectorAll(selector));
  const seen = new Set<Element>();
  const eligible: Element[] = [];
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el.closest("script, style, noscript, template")) continue;
    // Skip controls nested inside another control (e.g. a span in a button).
    if (el.parentElement?.closest("button, a[href], summary")) continue;
    if (!isVisible(el)) continue;
    eligible.push(el);
  }

  const controls: ControlInfo[] = [];
  for (const el of eligible.slice(0, args.maxControls)) {
    let ref = refIds.get(el);
    if (!ref || refs.get(ref) !== el) {
      ref = `e${++seq}`;
      refs.set(ref, el);
      refIds.set(el, ref);
    }
    const rect = el.getBoundingClientRect();
    const control: ControlInfo = {
      ref,
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      states: statesOf(el),
    };
    const type = el.getAttribute("type");
    if (type) control.type = type;
    const value = valueOf(el);
    if (value !== undefined) control.value = value;
    if (rect.width > 0 && rect.height > 0) {
      control.box = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }
    controls.push(control);
  }

  const textParts: string[] = [];
  let totalText = 0;
  let textTruncated = false;
  const excerptLimit = Math.max(args.maxText * 2, 2_000);

  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && !parent.closest("script, style, noscript, svg, canvas, iframe, template")) {
      const style = getComputedStyle(parent);
      if (style.display !== "none" && style.visibility !== "hidden") {
        const value = norm(node.nodeValue);
        if (value) {
          const last = textParts[textParts.length - 1];
          if (last !== value) {
            textParts.push(value);
            totalText += value.length + 1;
          }
        }
      }
    }
    if (totalText >= excerptLimit) {
      textTruncated = true;
      break;
    }
    node = walker.nextNode();
  }

  w.__bmRefSeq = seq;
  return {
    url: location.href,
    title: document.title,
    controls,
    totalControls: eligible.length,
    text: textParts.join(" ").slice(0, excerptLimit),
    textTruncated,
  };
}

export interface ReadableResult {
  html: string;
  title: string;
  url: string;
  byline: string;
  siteName: string;
}

export function extractReadable(): ReadableResult {
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const scoreCandidate = (el: Element): number => {
    const text = norm((el as HTMLElement).innerText);
    if (text.length < 250) return -1;
    const linkText = norm(
      Array.from(el.querySelectorAll("a"))
        .map((a) => (a as HTMLElement).innerText)
        .join(" "),
    ).length;
    const paragraphs = el.querySelectorAll("p").length;
    const headings = el.querySelectorAll("h1,h2,h3").length;
    return text.length - linkText * 1.2 + paragraphs * 25 + headings * 15;
  };

  const preferred = Array.from(document.querySelectorAll("article, main, [role='main']"));
  let best: Element | null = null;
  let bestScore = -1;
  for (const el of [...preferred, ...Array.from(document.querySelectorAll("div, section"))]) {
    const score = scoreCandidate(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  const root = best ?? document.body;
  const clone = root.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "script, style, noscript, template, svg, canvas, iframe, form, nav, header, footer, aside, " +
        "[aria-hidden='true'], [hidden], .ad, .ads, .advert, .advertisement, .cookie, .newsletter, .sidebar",
    )
    .forEach((el) => el.remove());

  const absolute = (value: string | null): string | null => {
    if (!value) return null;
    try {
      return new URL(value, location.href).href;
    } catch {
      return null;
    }
  };

  clone.querySelectorAll("a[href]").forEach((a) => {
    const href = absolute(a.getAttribute("href"));
    if (href && /^https?:/i.test(href)) a.setAttribute("href", href);
    else a.removeAttribute("href");
    a.removeAttribute("target");
    a.removeAttribute("rel");
  });

  clone.querySelectorAll("img").forEach((img) => {
    const src = absolute(img.getAttribute("src") ?? img.getAttribute("data-src"));
    if (src) img.setAttribute("src", src);
    else img.remove();
    img.removeAttribute("srcset");
    img.removeAttribute("loading");
    img.removeAttribute("class");
  });

  // Drop class/style noise to keep the markdown conversion cheap and clean.
  clone.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("class");
    el.removeAttribute("style");
    el.removeAttribute("id");
    el.removeAttribute("data-testid");
  });

  const meta = (name: string): string => {
    const el =
      document.querySelector(`meta[name="${name}"]`) ??
      document.querySelector(`meta[property="${name}"]`);
    return norm(el?.getAttribute("content"));
  };

  return {
    html: clone.innerHTML,
    title: norm(document.title) || norm(document.querySelector("h1")?.textContent),
    url: location.href,
    byline: meta("author") || meta("article:author"),
    siteName: meta("og:site_name"),
  };
}

export type ExtractMode = "links" | "tables" | "jsonld" | "meta" | "selector" | "text";

export interface SelectorField {
  selector: string;
  attr?: string;
  all?: boolean;
}

export function extractStructured(args: {
  mode: ExtractMode;
  selector?: Record<string, string | SelectorField>;
  limit: number;
}): unknown {
  const norm = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const absolute = (value: string | null): string => {
    if (!value) return "";
    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  };
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  if (args.mode === "links") {
    const links = Array.from(document.querySelectorAll("a[href]"))
      .filter(visible)
      .map((a) => ({
        text: norm((a as HTMLElement).innerText).slice(0, 200),
        href: absolute(a.getAttribute("href")),
        rel: a.getAttribute("rel") || undefined,
      }))
      .filter((link) => link.text || link.href)
      .slice(0, args.limit);
    return { url: location.href, title: document.title, links };
  }

  if (args.mode === "tables") {
    const tables = Array.from(document.querySelectorAll("table"))
      .slice(0, args.limit)
      .map((table) => {
        const rows = Array.from(table.querySelectorAll("tr"))
          .slice(0, 200)
          .map((row) =>
            Array.from(row.querySelectorAll("th, td")).map((cell) => norm(cell.textContent).slice(0, 300)),
          );
        const headerRow = Array.from(table.querySelectorAll("thead tr:first-child th")).map((cell) =>
          norm(cell.textContent),
        );
        return {
          caption: norm(table.querySelector("caption")?.textContent),
          headers: headerRow.length ? headerRow : rows[0] ?? [],
          rows: headerRow.length ? rows.slice(1) : rows.slice(1),
        };
      });
    return { url: location.href, title: document.title, tables };
  }

  if (args.mode === "jsonld") {
    const items: unknown[] = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const parsed = JSON.parse(script.textContent ?? "null");
        if (parsed) items.push(parsed);
      } catch {
        // ignore malformed blocks
      }
    });
    return { url: location.href, title: document.title, items: items.slice(0, args.limit) };
  }

  if (args.mode === "meta") {
    const metas: Record<string, string> = {};
    document.querySelectorAll("meta").forEach((meta) => {
      const key = meta.getAttribute("property") ?? meta.getAttribute("name");
      const content = meta.getAttribute("content");
      if (key && content) metas[key] = norm(content);
    });
    return {
      url: location.href,
      title: document.title,
      canonical: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? ""),
      h1: norm(document.querySelector("h1")?.textContent),
      description: metas.description ?? metas["og:description"] ?? "",
      meta: metas,
      jsonLdTypes: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((script) => {
          try {
            const parsed = JSON.parse(script.textContent ?? "null");
            return parsed?.["@type"] ?? null;
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    };
  }

  if (args.mode === "selector") {
    const result: Record<string, unknown> = {};
    for (const [key, rawField] of Object.entries(args.selector ?? {})) {
      const field: SelectorField = typeof rawField === "string" ? { selector: rawField } : rawField;
      const nodes = Array.from(document.querySelectorAll(field.selector));
      const read = (el: Element): string => {
        if (field.attr) return norm(el.getAttribute(field.attr));
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return norm((el as HTMLInputElement).value);
        if (tag === "META") return norm(el.getAttribute("content"));
        if (tag === "IMG") {
          return absolute(el.getAttribute("src") || (el as HTMLImageElement).currentSrc || "");
        }
        return norm((el as HTMLElement).innerText ?? el.textContent);
      };
      if (field.all) result[key] = nodes.slice(0, args.limit).map(read);
      else result[key] = nodes[0] ? read(nodes[0]) : null;
    }
    return { url: location.href, title: document.title, data: result };
  }

  // text
  return {
    url: location.href,
    title: document.title,
    text: norm(document.body?.innerText ?? ""),
  };
}

export interface StealthReport {
  webdriver: boolean;
  userAgent: string;
  uaData: unknown;
  languages: string[];
  locale: string;
  timezone: string;
  platform: string;
  vendor: string;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  plugins: string[];
  hasChrome: boolean;
  hasChromeRuntime: boolean;
  notificationPermission: string;
  permissionsQueryNative: boolean;
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  screen: Record<string, number>;
  window: Record<string, number>;
  hasMediaDevices: boolean;
  connection: string | null;
}

export function stealthReport(): StealthReport {
  const hash = (value: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };

  let canvasHash = "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 40;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.textBaseline = "top";
      ctx.font = "16px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(0, 0, 220, 40);
      ctx.fillStyle = "#069";
      ctx.fillText("browser-mcp fingerprint", 4, 8);
      canvasHash = hash(canvas.toDataURL());
    }
  } catch {
    canvasHash = "error";
  }

  let webglVendor = "";
  let webglRenderer = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) {
      webglVendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? "");
      webglRenderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
    }
  } catch {
    // ignore
  }

  const navigatorAny = navigator as any;
  const screenAny = screen as any;
  const uaData = navigatorAny.userAgentData
    ? {
        brands: navigatorAny.userAgentData.brands,
        mobile: navigatorAny.userAgentData.mobile,
        platform: navigatorAny.userAgentData.platform,
      }
    : null;

  return {
    webdriver: navigator.webdriver === true,
    userAgent: navigator.userAgent,
    uaData,
    languages: Array.from(navigator.languages ?? []),
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: navigator.platform,
    vendor: navigator.vendor,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: typeof navigatorAny.deviceMemory === "number" ? navigatorAny.deviceMemory : null,
    maxTouchPoints: navigator.maxTouchPoints,
    plugins: Array.from(navigator.plugins ?? []).map((plugin) => plugin.name),
    hasChrome: typeof (window as any).chrome === "object",
    hasChromeRuntime: Boolean((window as any).chrome?.runtime),
    notificationPermission:
      typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    permissionsQueryNative: /\[native code\]/.test(
      Function.prototype.toString.call(navigator.permissions?.query ?? (() => undefined)),
    ),
    canvasHash,
    webglVendor,
    webglRenderer,
    screen: {
      width: screenAny.width,
      height: screenAny.height,
      availWidth: screenAny.availWidth,
      availHeight: screenAny.availHeight,
      colorDepth: screenAny.colorDepth,
      pixelDepth: screenAny.pixelDepth,
    },
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    hasMediaDevices: Boolean(navigatorAny.mediaDevices),
    connection: navigatorAny.connection?.effectiveType ?? null,
  };
}

export interface CaptchaReport {
  detected: boolean;
  providers: string[];
  url: string;
  title: string;
  requiresHuman: boolean;
}

export function detectCaptcha(): CaptchaReport {
  const providers = new Set<string>();
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const selectors: Array<[string, string]> = [
    ['iframe[src*="recaptcha"]', "recaptcha"],
    ['[class*="g-recaptcha"]', "recaptcha"],
    ['iframe[src*="hcaptcha"]', "hcaptcha"],
    ['[class*="h-captcha"]', "hcaptcha"],
    ['iframe[src*="challenges.cloudflare.com"]', "turnstile"],
    ['[class*="cf-turnstile"]', "turnstile"],
    ['[data-turnstile-sitekey]', "turnstile"],
    ['iframe[src*="captcha-delivery.com"]', "datadome"],
    ['[class*="datadome"]', "datadome"],
    ['#px-captcha', "perimeterx"],
    ['[class*="perimeterx"]', "perimeterx"],
    ['iframe[src*="arkose"]', "arkose"],
    ['[data-arkose]', "arkose"],
    ['[class*="geetest"]', "geetest"],
  ];
  // A widget stays in the DOM after a human solves it. Prefer the provider's
  // response token so a solved challenge reads as clear instead of forever
  // detected.
  const hasToken = (provider: string): boolean => {
    const filled = (selector: string): boolean => {
      const el = document.querySelector(selector) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      return Boolean(el && typeof el.value === "string" && el.value.trim());
    };
    try {
      const w = window as any;
      if (provider === "recaptcha") {
        const api =
          typeof w.grecaptcha?.getResponse === "function" && Boolean(w.grecaptcha.getResponse());
        return (
          api ||
          filled('textarea[name="g-recaptcha-response"]') ||
          filled('input[name="g-recaptcha-response"]')
        );
      }
      if (provider === "hcaptcha") {
        const api =
          typeof w.hcaptcha?.getResponse === "function" && Boolean(w.hcaptcha.getResponse());
        return (
          api ||
          filled('textarea[name="h-captcha-response"]') ||
          filled('input[name="h-captcha-response"]')
        );
      }
      if (provider === "turnstile") {
        const api =
          typeof w.turnstile?.getResponse === "function" && Boolean(w.turnstile.getResponse());
        return (
          api ||
          filled('input[name="cf-turnstile-response"]') ||
          filled('textarea[name="cf-turnstile-response"]')
        );
      }
    } catch {
      // Cross-origin widget APIs can throw; fall back to selector detection.
    }
    return false;
  };
  for (const [selector, provider] of selectors) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (visible(el) && !hasToken(provider)) providers.add(provider);
    }
  }
  const text = (document.body?.innerText ?? "").slice(0, 8_000);
  if (/verify (?:that )?you are (?:a )?human|are you a robot|complete the captcha|checking your browser/i.test(text)) {
    providers.add("text-challenge");
  }
  if (/just a moment|attention required|verify you are human/i.test(document.title)) {
    providers.add("cloudflare");
  }
  const result = [...providers];
  return {
    detected: result.length > 0,
    providers: result,
    url: location.href,
    title: document.title,
    requiresHuman: result.length > 0,
  };
}

export interface VitalsData {
  lcp: number;
  cls: number;
  fcp: number;
  ttfb: number;
  longTasks: number;
  longTaskDuration: number;
  firstInput: number | null;
  domContentLoaded: number;
  load: number;
}

export function installVitals(): boolean {
  const w = window as any;
  if (w.__bmVitals) return true;
  const vitals: VitalsData = {
    lcp: 0,
    cls: 0,
    fcp: 0,
    ttfb: 0,
    longTasks: 0,
    longTaskDuration: 0,
    firstInput: null,
    domContentLoaded: 0,
    load: 0,
  };
  w.__bmVitals = vitals;

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        vitals.lcp = Math.max(vitals.lcp, entry.startTime);
      }
    }).observe({ type: "largest-contentful-paint", buffered: true } as any);
  } catch {
    // unsupported
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput) vitals.cls += entry.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: true } as any);
  } catch {
    // unsupported
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        vitals.longTasks += 1;
        vitals.longTaskDuration += entry.duration;
      }
    }).observe({ type: "longtask", buffered: true } as any);
  } catch {
    // unsupported
  }
  try {
    new PerformanceObserver((list) => {
      const entry = list.getEntries()[0] as any;
      if (entry && vitals.firstInput === null) vitals.firstInput = entry.processingStart - entry.startTime;
    }).observe({ type: "first-input", buffered: true } as any);
  } catch {
    // unsupported
  }

  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) {
    vitals.ttfb = nav.responseStart;
    vitals.domContentLoaded = nav.domContentLoadedEventEnd;
    vitals.load = nav.loadEventEnd;
  }
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  if (fcp) vitals.fcp = fcp.startTime;
  return true;
}

export function readVitals(): VitalsData | null {
  return (window as any).__bmVitals ?? null;
}

export function resourceTimings(limit: number): Array<Record<string, unknown>> {
  return performance
    .getEntriesByType("resource")
    .map((entry) => {
      const e = entry as PerformanceResourceTiming;
      return {
        name: e.name,
        type: e.initiatorType,
        startTime: Math.round(e.startTime),
        duration: Math.round(e.duration),
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
      };
    })
    .sort((a, b) => (b.duration as number) - (a.duration as number))
    .slice(0, limit);
}
