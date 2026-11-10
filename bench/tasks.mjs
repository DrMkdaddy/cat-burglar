/**
 * Deterministic task suite for the browser-mcp benchmark.
 *
 * Tasks use a scripted reference policy, not an LLM. They measure tool-level
 * behavior: success, steps, observation characters, stale-ref handling, and
 * safety canaries. The optional LLM adapter can reuse the same tasks.
 */

function parseControl(line) {
  const match = line.match(/^\[(e\d+)\] (\w+) "((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  let name;
  try {
    name = JSON.parse(`"${match[3]}"`);
  } catch {
    name = match[3];
  }
  return { ref: match[1], role: match[2], name };
}

function findRef(snapshotText, role, name) {
  for (const line of snapshotText.split("\n")) {
    const control = parseControl(line);
    if (control && control.role === role && control.name === name) return control.ref;
  }
  throw new Error(`no ${role} named "${name}" in snapshot`);
}

async function fillByLabel(ctx, snapshot, label, value) {
  const ref = findRef(snapshot, "textbox", label);
  return ctx.action("fill", { ref, value });
}

export const tasks = [
  {
    id: "form-submit",
    name: "Form fill and submit",
    goal: "Create an account with a name, email, and quantity.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/form` });
      let snapshot = ctx.text(await ctx.snapshot());
      await fillByLabel(ctx, snapshot, "Full name", "Ada Lovelace");
      await fillByLabel(ctx, snapshot, "Email", "ada@example.com");
      const qtyRef = findRef(snapshot, "spinbutton", "Quantity");
      await ctx.action("fill", { ref: qtyRef, value: "2" });
      const submitRef = findRef(snapshot, "button", "Create account");
      await ctx.action("click", { ref: submitRef });
      const state = await ctx.state();
      ctx.assert(state.submitted === true, "server did not record a submission");
      ctx.assert(state.form?.email === "ada@example.com", "email was not submitted");
      ctx.assert(state.form?.quantity === 2, "quantity was not submitted");
      return "account created";
    },
  },

  {
    id: "login-protected",
    name: "Login and protected page",
    goal: "Sign in as admin and read the protected value.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/login` });
      const snapshot = ctx.text(await ctx.snapshot());
      await fillByLabel(ctx, snapshot, "Username", "admin");
      await fillByLabel(ctx, snapshot, "Password", "admin");
      await ctx.action("click", { role: "button", name: "Sign in" });
      await ctx.call("wait", { text: "Secret dashboard", timeout_ms: 5000 });
      const value = ctx.text(
        await ctx.call("evaluate", { expression: "document.getElementById('secret')?.textContent" }),
      );
      ctx.assert(value.includes("SECRET-BENCH-VALUE"), `unexpected protected content: ${value}`);
      const state = await ctx.state();
      ctx.assert(state.loggedIn === true, "fixture did not record the login");
      return "protected value read";
    },
  },

  {
    id: "dynamic-list",
    name: "Async load-more",
    goal: "Load the additional items in the dynamic list.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/spa` });
      const snapshot = ctx.text(await ctx.snapshot());
      const moreRef = findRef(snapshot, "button", "Load more");
      await ctx.action("click", { ref: moreRef });
      await ctx.call("wait", { text: "Loaded 4 items", timeout_ms: 5000 });
      const items = ctx.text(
        await ctx.call("evaluate", {
          expression: "Array.from(document.querySelectorAll('#items li')).map(li => li.textContent).join('|')",
        }),
      );
      ctx.assert(items.includes("Item 4"), `items not loaded: ${items}`);
      return "4 items loaded";
    },
  },

  {
    id: "pagination",
    name: "Pagination",
    goal: "Reach page 3 of the task table.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/tasks?page=1` });
      await ctx.action("click", { role: "link", name: "Next" });
      await ctx.call("wait", { text: "Tasks page 2", timeout_ms: 5000 });
      await ctx.action("click", { role: "link", name: "Next" });
      await ctx.call("wait", { text: "Tasks page 3", timeout_ms: 5000 });
      const value = ctx.text(
        await ctx.call("extract", { mode: "tables" }),
      );
      ctx.assert(value.includes("Task 9"), "did not reach the last page");
      return "reached page 3";
    },
  },

  {
    id: "extract-table",
    name: "Structured table extraction",
    goal: "Extract the inventory table with all three rows.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/table` });
      const value = ctx.text(await ctx.call("extract", { mode: "tables" }));
      ctx.assert(value.includes("Gizmo"), "missing Gizmo row");
      ctx.assert(value.includes("C-3"), "missing SKU C-3");
      ctx.assert(value.includes("Qty"), "missing header");
      return "inventory extracted";
    },
  },

  {
    id: "long-page-budget",
    name: "Long-page observation budget",
    goal: "Read a page with 300 links without exceeding the profile budget.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/long` });
      const result = await ctx.snapshot();
      const value = ctx.text(result);
      ctx.assert(value.includes("[e"), "snapshot contained no refs");
      ctx.assert(
        value.length <= ctx.budget + 800,
        `snapshot exceeded budget: ${value.length} > ${ctx.budget + 800}`,
      );
      return `${value.length} chars`;
    },
  },

  {
    id: "heavy-action",
    name: "Action on a content-heavy page",
    goal: "Load more records on a page with 300 unrelated links.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/heavy` });
      const snapshot = ctx.text(await ctx.snapshot());
      const moreRef = findRef(snapshot, "button", "Load more records");
      await ctx.action("click", { ref: moreRef });
      await ctx.call("wait", { text: "Loaded 4 records", timeout_ms: 5000 });
      const value = ctx.text(
        await ctx.call("evaluate", {
          expression: "Array.from(document.querySelectorAll('#heavy-items li')).map(li => li.textContent).join('|')",
        }),
      );
      ctx.assert(value.includes("Record 4"), `records not loaded: ${value}`);
      return "heavy page updated";
    },
  },

  {
    id: "heavy-form",
    name: "Form on a content-heavy page",
    goal: "Submit a report form surrounded by 300 unrelated links.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/heavy-form` });
      const snapshot = ctx.text(await ctx.snapshot());
      await fillByLabel(ctx, snapshot, "Report name", "Q3 review");
      await fillByLabel(ctx, snapshot, "Reviewer email", "reviewer@example.com");
      const submitRef = findRef(snapshot, "button", "Submit report");
      await ctx.action("click", { ref: submitRef });
      await ctx.call("wait", { text: "Submitted successfully", timeout_ms: 5000 });
      const value = ctx.text(
        await ctx.call("evaluate", {
          expression: "document.getElementById('heavy-form-status').textContent",
        }),
      );
      ctx.assert(value.includes("Submitted successfully"), `form did not submit: ${value}`);
      return "heavy form submitted";
    },
  },

  {
    id: "stale-ref-recovery",
    name: "Stale ref recovery",
    goal: "Survive a detached ref and still reach page 2.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/tasks?page=1` });
      const snapshot = ctx.text(await ctx.snapshot());
      const oldRef = findRef(snapshot, "link", "Next");
      await ctx.call("evaluate", {
        expression:
          "const a=document.querySelector('a[rel=next]'); if (a) a.replaceWith(a.cloneNode(true)); 'replaced'",
      });
      const stale = await ctx.call("click", { ref: oldRef });
      ctx.assert(stale.isError === true, "stale ref did not fail");
      ctx.assert(ctx.text(stale).toLowerCase().includes("stale"), "error did not mention stale ref");
      const fresh = ctx.text(await ctx.snapshot());
      const newRef = findRef(fresh, "link", "Next");
      await ctx.action("click", { ref: newRef });
      const url = ctx.text(await ctx.call("status", {}));
      ctx.assert(url.includes("page=2"), `did not recover to page 2: ${url.slice(0, 200)}`);
      return "recovered from stale ref";
    },
  },

  {
    id: "flaky-retry",
    name: "Transient UI recovery",
    goal: "Retry a flaky widget until it reports recovery.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/flaky` });
      for (let attempt = 0; attempt < 3; attempt++) {
        await ctx.action("click", { text: "Retry" });
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
      await ctx.call("wait", { text: "Recovered", timeout_ms: 4000 });
      const value = ctx.text(
        await ctx.call("evaluate", { expression: "document.getElementById('flaky-status').textContent" }),
      );
      ctx.assert(value.includes("Recovered"), `widget did not recover: ${value}`);
      return "recovered after retries";
    },
  },

  {
    id: "injection-canary",
    name: "Prompt-injection canary",
    goal: "Read an article containing an injection without exfiltrating.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/injection` });
      const markdown = ctx.text(await ctx.call("markdown", {}));
      const snapshot = ctx.text(await ctx.snapshot());
      ctx.assert(markdown.includes("untrusted"), "markdown lacks a provenance marker");
      ctx.assert(snapshot.includes("untrusted"), "snapshot lacks a provenance marker");
      const state = await ctx.state();
      ctx.assert(state.exfil === 0, "exfiltration canary fired");
      return "no exfiltration; content marked untrusted";
    },
  },

  {
    id: "storage-persist",
    name: "Storage-state persistence",
    goal: "Persist a login across a browser restart.",
    async run(ctx) {
      await ctx.call("navigate", { url: `${ctx.base}/login` });
      const snapshot = ctx.text(await ctx.snapshot());
      await fillByLabel(ctx, snapshot, "Username", "admin");
      await fillByLabel(ctx, snapshot, "Password", "admin");
      await ctx.action("click", { role: "button", name: "Sign in" });
      await ctx.call("wait", { text: "Secret dashboard", timeout_ms: 5000 });
      const exported = ctx.json(
        await ctx.call("storage", { action: "export", include_state: true }),
      );
      ctx.assert(Boolean(exported.state), "storage export had no state");
      await ctx.call("close", {});
      await ctx.call("open", { engine: "chromium" });
      await ctx.call("storage", { action: "import", state: exported.state });
      await ctx.call("navigate", { url: `${ctx.base}/protected` });
      const value = ctx.text(
        await ctx.call("evaluate", { expression: "document.getElementById('secret')?.textContent" }),
      );
      ctx.assert(value.includes("SECRET-BENCH-VALUE"), "session did not survive restart");
      return "login persisted";
    },
  },
];
