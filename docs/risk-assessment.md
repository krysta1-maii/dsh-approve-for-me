# R4 risk and authorization assessment

R4 supplies evidence-bound facts to the gate; it is not an allow policy. The assessor receives only the branded, source-verified dossier action and direct-user event references. It does not parse message text, infer user intent from a command name or workspace path, or elevate model-produced claims.

## Taxonomy

The stable vocabulary is: data exfiltration, credential access, destructive change, persistent security weakening, permission expansion, network exposure, supply-chain or unverified execution, approval evasion, and unknown semantics. `RISK_RULES_V1` provides one versioned entry for each category, with a structural trigger, counterevidence, scope, authorization requirement, manual-confirmation condition, and absolute-denial condition. A rule whose adapter is not yet proved remains unasserted; the matrix is not a license to infer facts from free text.

The current baseline has only auditable structural triggers:

- network semantics record network exposure; a body or headers also record data-exfiltration risk;
- filesystem destructive operations record destructive-change risk;
- a `danger-full-access` sandbox request records permission expansion and critical risk;
- unrecognized semantic families record unknown semantics.

Categories without a proved structural source remain unasserted. This prevents a speculative label from masquerading as evidence.

## Authorization and gate behavior

Direct-user event references establish provenance, not authorization. Until a future verifier can prove that a direct-user source covers both the exact target and the proposed side effects, the assessment is `unknown` and both coverage flags are false.

For a source-verified production dossier, an absent assessment is unavailable. An unknown/incomplete assessment skips trust-envelope, allow-cache, and sealed-replay fast paths but continues to Guardian pre-review. The baseline therefore cannot create an automatic allow.
