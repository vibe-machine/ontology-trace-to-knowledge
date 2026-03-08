# Package Contract

This repository publishes the `Trace-to-Knowledge` ontology package using the self-describing documentation and provenance contract established by `ontology-gist`.

Current package boundaries:

- `schema/`: package schema plus the shared self-describing/provenance schemas
- `data/`: queryable provenance records and generated schema documentation records
- `manifests/`: machine-readable package manifest for deterministic artifact tracking
- `tools/package_contract/`: refresh and validation tooling for this hand-authored package

Current status:

- `schema/traceToKnowledge.tql` is the hand-authored source of truth for the ontology model.
- `data/trace-to-knowledge-schema-docs.tql` is generated from the schema and is the authoritative documentation path for package-local schema resources.
- `data/trace-to-knowledge-provenance.tql` records the package build, source artifacts, and generated artifact checksums.
- `manifests/trace-to-knowledge-v1.0.0.package-manifest.json` is the filesystem source of truth for the package contract.
- `tools/package_contract/refresh_package_contract.mjs` regenerates documentation and provenance artifacts from the current schema and package metadata.
- `tools/package_contract/validate_bootstrap.mjs` validates the package contract and artifact hashes.
- `tools/package_contract/validate_typedb_bootstrap.mjs` proves the package can load into TypeDB with its declared dependency closure.

Design references:

- `Design: TypeDB Schema Documentation & Provenance`
  - https://www.notion.so/31bc633a07178161923fd6f322f0e5fb
- `Design: Self-Describing Schema`
  - https://www.notion.so/31cc633a07178180b139cb56c3c80268

Canonical contract reference:

- `ontology-gist`
  - https://github.com/vibe-machine/ontology-gist

This package is hand-authored. It does not vendor upstream OWL source files or ship an OWL translation pipeline, but it still follows the same documentation/provenance contract so downstream loaders and tooling can treat ontology packages consistently.
