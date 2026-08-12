// orchestration-check.ts — static contract assertions for evidence ownership
// (non-duplication). This is NOT a clone-isolation test (that is clone-check.ts).
// It pins the prompt/skill contract wording so the delegation gate, owned scope,
// ownership transfer, and bounded-integration language cannot silently regress.
// There is no runtime enforcement (by design): the earlier synthetic
// transcript-marker audit could not prove real orchestration and was removed —
// deeper behavior is verified by the manual recorded-session checklist in
// docs/read-only-subagent-runs.md. Run: bun orchestration-check.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HANDOFF_CONTRACT } from "./extensions/subagents/lib.ts";

let failures = 0;
function check(name: string, condition: boolean) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const skill = readFileSync(`${repoRoot}skills/subagent-orchestration/SKILL.md`, "utf8");
const doc = readFileSync(`${repoRoot}docs/read-only-subagent-runs.md`, "utf8");
const contract = HANDOFF_CONTRACT;

// --- 1. Handoff contract wording (shared by every child, writer included) ---

check("contract: keeps the four labeled sections", ["Outcome", "Evidence", "Risks", "Next"].every((section) => contract.includes(section)));
check("contract: Evidence's first item is Baseline", contract.includes("Evidence: the first item is Baseline"));
check("contract: read-only runs report the injected sha/as-of/fingerprint", contract.includes("read-only runs") && contract.includes("injected HEAD sha") && contract.includes("as-of") && contract.includes("fingerprint"));
check("contract: writers report only their known starting HEAD/cwd, never a fabricated fingerprint", contract.includes("starting HEAD") && contract.includes("working directory") && contract.includes("never fabricate"));
check("contract: dynamic resources carry inspected update markers", contract.includes("update markers"));
check("contract: each claim carries minimal supporting evidence", contract.includes("smallest supporting evidence"));
check("contract: handoff ends with inspected resources for delta-checking", contract.includes("inspected resources"));
check("contract: Risks' first item is Needs parent verification", contract.includes("Risks: the first item is Needs parent verification"));
check("contract: verification items are narrow, never re-doable exploration", contract.includes("narrow items") && contract.includes("Never re-doable exploration"));
check("contract: stays under 6KB", Buffer.byteLength(contract) <= 6 * 1024);

// --- 2. Skill wording: the parent-side contract ---

check("skill: delegation gate — routing inventory only, no pre-reads", skill.includes("routing inventory") && skill.includes("Do not pre-read"));
check("skill: delegated task must carry objective/scope/out-of-scope/baseline/verdict/stopping condition", ["objective", "owned resources / scope", "out of scope", "baseline / as-of", "expected verdict / output", "stopping condition"].every((term) => skill.includes(term)));
check("skill: ownership transfer — parent does not run the same exploration in parallel", skill.includes("you do not run the same exploration in parallel before the handoff"));
check("skill: siblings default disjoint; overlap only for voting/cross-check", skill.includes("non-overlapping") && skill.includes("voting or cross-check"));
check("skill: one batched freshness delta, then adopt unchanged handoffs", skill.includes("one batched freshness delta") && skill.includes("adopt the handoff"));
check("skill: changed resource re-reviewed only for its affected finding", skill.includes("re-review only the affected finding"));
check("skill: one narrow check per Needs-parent-verification item", skill.includes("Needs-parent-verification item gets exactly one narrow check"));
check("skill: tie-break checks for conflicts, canonical gates once, predicate checks before acting", skill.includes("tie-break") && skill.includes("canonical") && skill.includes("predicate"));
check("skill: verification vs re-exploration — re-exploration prohibited", skill.includes("Verification is a yes/no") && skill.includes("Re-exploration") && skill.includes("prohibited"));
check("skill: incomplete handoff gets a bounded follow-up, never a parent take-over", skill.includes("bounded follow-up") && skill.includes("uncertainty") && skill.includes("Never silently take over"));

// --- 3. Documentation: static assertions + a manual checklist, no runtime enforcement claim ---

check("docs: non-dup contract is described as prompt/skill + a manual recorded-session checklist", doc.includes("static contract assertions") && doc.includes("recorded-session") && doc.includes("checklist") && doc.includes("manual"));
check("docs: orchestration is not enforced at runtime", doc.includes("not enforced at runtime"));

if (failures > 0) {
	console.error(`\n${failures} orchestration check(s) FAILED`);
	process.exit(1);
}
console.log("\nall orchestration checks passed");
