# Trace-to-Knowledge Schema Model

Trace-to-Knowledge (T2K) models the path from raw operational trace to reusable knowledge. It is built on top of `ontology-gist`, so it reuses gist identifiers, text-bearing content types, temporal context, and tagging rather than redefining those primitives.

## Core idea

T2K separates four concerns that often get blurred together in debugging and operations notes:

- raw evidence: what was observed
- execution context: where and when it was observed
- reusable knowledge: what we learned from it
- retrieval/index hooks: how we find that knowledge again later

That separation is what makes the package high-signal. The ontology is not trying to preserve every trace detail as first-class schema. It is trying to preserve enough provenance and applicability to support trustworthy reuse.

## Knowledge items

`KnowledgeItem` is the abstract center of the model. It is a `ContentExpression`, so it inherits gist's basic text-bearing semantics and identifier pattern.

Every knowledge item can carry:

- `name` and `description` for human-readable guidance
- `uniqueText` for stable textual identity when useful
- `sourceIRI` for a durable external source pointer
- `shodhMemoryId` when synchronized with an external memory system
- `confidence`, `verified`, and `deprecated` to qualify trust and lifecycle

T2K then specializes knowledge into four operational shapes:

- `FailurePattern`: recurring symptom or breakage
- `FixPattern`: reusable corrective pattern
- `Procedure`: ordered operational recipe
- `Heuristic`: practical rule of thumb under uncertainty

## Signatures

`Signature` exists to make knowledge retrievable from future traces. A signature is not the knowledge itself. It is the matching hook, such as normalized error text, a stack-frame fragment, or another compact signal.

The `signatureLink` relation maps signatures to knowledge items. That lets one knowledge item have multiple ways to be recognized, each with its own confidence.

## Scope

`Scope` is the applicability boundary for knowledge. It answers questions like:

- which language?
- which tool?
- which package and version?
- which file?
- which symbol?

The key modeling choice is that scope is structured and atomic. It is not a bag of prose. The `appliesTo` relation links knowledge to the scope instances that make it relevant.

## Evidence and runs

`EvidenceItem` captures the local evidence T2K uses as provenance. `Run` captures the execution context that produced the evidence. `observedIn` links the two.

`ExternalEvidence` is different: it points to the canonical artifact in some other system. This is how T2K can reference a GitHub issue, beads item, CI log, or similar external source without importing that system's full data model.

`evidenceRef` links local evidence to the external reference when both are needed.

## Distillation and support

T2K uses two different provenance relations on purpose:

- `supportedBy`: evidence supports a claim
- `extractedFrom`: knowledge was distilled from evidence in a run

That distinction matters. Support says why we believe a claim. Extraction says where the reusable knowledge came from.

## Knowledge lifecycle

The ontology also models how knowledge changes over time:

- `supersedes`: newer guidance replaces older guidance
- `contradicts`: two knowledge items conflict
- `prerequisiteOf`: one item must be understood or performed before another
- `resolves`: a fix pattern addresses a failure pattern

These are what let T2K act like an operational knowledge graph rather than a flat note store.

## Tagging

T2K deliberately reuses gist's `Tag` rather than defining a second tag type. `hasMemoryTag` gives a lightweight navigation layer on top of the more explicit scope and provenance relations.

## Identifier strategy

T2K relies on gist's `ID` pattern through `isIdentifiedBy` rather than inventing local key attributes for every entity. That keeps the package aligned with the rest of the ontology ecosystem and makes it easier to integrate with other gist-based packages.

In practice:

- use gist `ID` instances when you need durable, explicit identifiers
- use `uniqueText` when a stable text key is enough
- use `sourceIRI` or `idText` when the source system already provides an identifier

## Reading the graph

The most important path in the ontology is:

1. a `Run` happens
2. `EvidenceItem` is `observedIn` that run
3. a `KnowledgeItem` is `extractedFrom` that evidence and run
4. the knowledge is refined with `Scope`, `Signature`, tags, and lifecycle relations
5. future traces can match the `Signature` and recover the knowledge

That is the trace-to-knowledge loop the package is designed to make explicit.
