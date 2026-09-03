# R4 risk and authorization assessment

R4 supplies evidence-bound facts to the gate; it is not the final Reviewer decision. The assessor receives the branded, source-verified dossier action and retained direct-user content. It recognizes only the exact structured `/approve-for-me` form for deterministic authorization and does not infer ordinary natural-language intent; that interpretation belongs to the fresh Reviewer reading the complete dossier.

## Taxonomy

The stable vocabulary is: data exfiltration, credential access, destructive change, persistent security weakening, permission expansion, network exposure, supply-chain or unverified execution, approval evasion, and unknown semantics. `RISK_RULES_V1` provides one versioned entry for each category, with a structural trigger, counterevidence, scope, authorization requirement, manual-confirmation condition, and absolute-denial condition. A rule whose adapter is not yet proved remains unasserted; the matrix is not a license to infer facts from free text.

The current baseline has only auditable structural triggers:

- network semantics record network exposure; a body or headers also record data-exfiltration risk;
- filesystem destructive operations record destructive-change risk;
- a `danger-full-access` sandbox request records permission expansion and critical risk;
- unrecognized semantic families record unknown semantics.

Categories without a proved structural source remain unasserted. This prevents a speculative label from masquerading as evidence.

## Authorization and gate behavior

An exact standalone `/approve-for-me` directive can establish deterministic target/side-effect coverage. Ordinary natural-language messages retain provenance and full content in the dossier but remain non-authorizing in this baseline; the Reviewer may still judge them explicit when they clearly request the pending action.

For a source-verified production dossier, an absent assessment is unavailable. An unknown/incomplete assessment skips authorization-derived allow-cache and sealed-replay fast paths but continues to Guardian pre-review, whose identity-valid allow/deny/human_review is the final business disposition. The separately configured trust envelope remains an independent administrative grant path. The baseline itself cannot create a new automatic allow.
