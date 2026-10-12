# Repository Engineering Guide

This file governs the entire repository. Direct user instructions take
precedence; otherwise, this is the authoritative engineering and Git policy
when another repository document conflicts. A more deeply nested `AGENTS.md`
may add stricter, local rules for its subtree.

## Work collaboratively

- Read `README.md`, available contribution guidelines, current project status,
  architecture and product decisions, and the relevant code and tests before
  proposing changes. Treat historical documents as context, never as the
  current roadmap or implementation status.
- Consult documented product principles and architecture decisions before
  changing product behavior, public APIs, data contracts, authentication,
  persistence, caching, or observability policy. Evaluate proposals against
  their stated constraints and decision criteria.
- Before material edits, state the intended outcome, scope, assumptions, and
  verification plan. Surface consequential design choices instead of silently
  deciding them.
- Preserve unrelated work and keep changes within the agreed scope. Do not
  commit, push, open a pull request, merge, or rename a shared branch without
  explicit authorization.

## Repository contract

- Discover the supported languages, runtimes, platforms, and toolchain from
  repository documentation, manifests, and CI configuration. Keep changes
  compatible with that contract; change support requirements deliberately and
  update their documentation and enforcement together.
- Use the repository's authoritative manifests for packaging, dependencies,
  and tool configuration. Separate runtime dependencies from development
  tools, and do not duplicate dependency lists or declare built-in libraries
  as external packages.
- Use documented shared commands for setup, formatting, testing, and the
  complete local/CI quality checks. If tooling is being introduced, establish
  one reproducible workflow and document it instead of assuming commands exist.
- Follow the established source and package layout. Keep domain code within
  its owning module; move code to a shared layer only when multiple consumers
  need the same contract.

## Build durable software

- Write production-quality code for known requirements. Do not use “POC,”
  “MVP,” “temporary,” or future cleanup as reasons to weaken correctness,
  security, validation, error handling, observability, or resource ownership.
- Choose the simplest design that is sound and maintainable for credible
  extension points. Avoid both knowingly inferior shortcuts and speculative
  abstractions for hypothetical features.
- If the correct solution materially exceeds the agreed scope, explain the
  tradeoff and obtain direction. If deferral is approved, create a tracked
  issue; do not quietly ship debt behind a TODO.

## Documentation and code comments

- Use the language's standard documentation conventions and the repository's
  established format. Document every public module, type, function, and method,
  plus internal code whose contract is not obvious. Start with a concise
  summary and separate further detail clearly.
- Document behavior and meaning: parameter semantics, return semantics,
  errors, units, mutation, side effects, invariants, and resource ownership
  when relevant. Do not narrate the implementation.
- Keep types in the language's type system where available. Avoid duplicating
  signatures, defaults, or type declarations in prose unless the documentation
  format requires it or they clarify behavior the declaration cannot express.
- Use comments to explain intent, constraints, and non-obvious decisions.
  Remove stale comments and update documentation alongside the behavior it
  describes.
- Keep setup instructions, configuration, examples, public contracts, and
  operational guidance accurate and reproducible. Explain intentional breaking
  changes and migration steps in the same change that introduces them.
- Record consequential architecture decisions with their context, alternatives,
  tradeoffs, and acceptance evidence. Distinguish implemented behavior from
  proposals and future work.

## Types and data contracts

- Where the language supports static typing, keep new and changed code fully
  typed. Express public interfaces, callbacks, shared state, and structured
  data clearly; add explicit annotations when inference obscures meaning.
- Accept the narrowest useful interface and return the concrete contract
  promised. Use domain types and structured schemas to encode real constraints.
- Do not use unchecked or catch-all types as escape hatches. Represent unknown
  values explicitly and validate or narrow them before use. Confine unavoidable
  untyped third-party boundaries, document the reason, and prevent weak types
  from propagating into domain code.
- A type assertion, unchecked cast, or checker suppression does not prove
  safety. Use a narrow suppression only after proving the invariant and
  documenting the reason; select a specific diagnostic where supported.
- Treat static types as contracts, not runtime validation. Validate all
  untrusted external data at the system boundary.
- Legacy weak contracts are not precedent. Improve relevant adjacent contracts
  when safe, but keep broad migrations as dedicated, reviewable changes.

## Design and structure

- Organize by domain and capability. Separate domain behavior from transport,
  validation and serialization, persistence, and presentation. Avoid catch-all
  utility, helper, base, or constants modules.
- Favor cohesive modules, small explicit interfaces, and high-level policy that
  does not depend directly on volatile I/O details. Inject transports, clocks,
  configuration, and other side-effecting dependencies at clear boundaries.
- Use a function when no identity or state is required. Use an object to protect
  a stable invariant, own a resource or lifecycle, or provide meaningful
  polymorphism, rather than merely to group functions.
- Prefer composition and dependency injection. Inherit only for genuine
  behavioral substitutability and keep hierarchies shallow. Use small interfaces
  for shared contracts and nominal hierarchies only when they add a necessary
  constraint.
- Keep the public API intentionally small. Encapsulate internals using the
  language's visibility conventions and do not expose an implementation detail
  merely to test it.
- Make ownership and lifetime explicit for connections, tasks, files, and other
  resources. Use deterministic cleanup and preserve cancellation in asynchronous
  code.
- Reuse existing schemas and domain models when they express the same concept.
  Add a parallel model only when it has a distinct semantic responsibility.

## Single sources of truth

- Remove duplicated knowledge, not merely similar-looking syntax. Give each
  configuration value, constant, endpoint, default, field mapping, schema, and
  domain invariant one authoritative owner and derive secondary forms where
  practical.
- Put shared knowledge at the narrowest stable layer that owns it. Do not create
  a global registry or abstraction for concepts that only happen to look alike;
  premature deduplication creates coupling instead of removing it.
- Avoid mutable global state and initialization side effects. Prefer immutable
  values and configuration objects; declare true constants using the language's
  conventions.
- Do not add a dependency when built-in facilities adequately solve the problem.
  Justify every new dependency by maintenance, security, and operational value.

## Performance, concurrency, and resource bounds

- Use established runtime and library operations for common work. Keep custom
  algorithms focused on semantics those operations cannot faithfully express.
- Make concurrency, buffering, retries, and materialization boundaries explicit.
  Bound resource use and avoid hidden whole-input collection in otherwise
  streaming, batched, or asynchronous workflows.
- Preserve validation, ordering, uniqueness, and other declared invariants
  across batches and concurrent tasks. Local checks alone do not prove a global
  contract.
- Keep credentials, policy decisions, accounting, and authoritative state
  changes under clear ownership. Document coordination and failure behavior
  when work crosses process or service boundaries.
- Verify performance claims with representative workloads and measured runtime
  and resource use. Moving work to another thread or process does not by itself
  prove scalability or an improvement.

## Errors, security, and external I/O

- Raise or return specific, actionable errors with relevant safe context.
  Preserve the original cause using the language's error mechanisms. Do not
  catch indiscriminately, swallow failures, or silently return partial results.
  If partial results are part of the contract, expose their coverage and failures
  explicitly.
- Validate external inputs and responses before they enter domain code. Never
  commit credentials, log secrets or tokens, disable TLS verification, or create
  unbounded network calls. Use explicit timeouts and deterministic cleanup.
- Do not copy, expand, or normalize insecure behavior because it already exists.
  Track known debt and keep new work within the documented security contract.
- A TODO must reference a tracked issue and explain the remaining invariant or
  decision. It may record an explicitly approved deferral, but must not be used
  unilaterally to postpone correctness, security, or resource cleanup.

## Test behavior, not implementation

- Black-box tests are the default acceptance evidence. Exercise realistic data
  flow through the built or installed software and its public interface: inputs,
  external boundaries, validation and transformation, results, documented errors,
  and cleanup.
- Test through the nearest externally usable interface when a cohesive public
  API does not yet exist. Do not invent a public API as incidental test work.
- Use real, isolated resources for integration tests when they provide stronger
  acceptance evidence: temporary directories, local test servers, and disposable
  databases. Give each test ownership of its resources and data, provide
  deterministic cleanup, and avoid shared development or production state.
- Mock unavailable or nondeterministic services, and control clocks and
  environment where needed for reproducibility. Do not mock the code under
  test's own helpers. Assert observable outputs, state, errors, and external
  effects, rather than private attributes, helper call order, or internal
  choreography unless that interaction is itself a public contract.
- Cover the successful path plus meaningful boundary and failure cases. A
  behavioral bug fix requires a regression test that fails through the public
  behavior before the fix. Focused unit tests are appropriate for complex pure
  logic, but they must still test its contract rather than its implementation.
- Keep tests deterministic, isolated, independent of execution order, and free
  of dependencies on live external services by default. Local test servers and
  disposable services are permitted. Test the actual build or package without
  ad hoc search-path changes. Maintain a clean-build and startup or import smoke
  path as appropriate for the project.
- Keep the default suite fast enough for routine development and CI. Use small
  representative fixtures, event handshakes instead of fixed waiting periods,
  and bounded parallel execution where supported. Keep tests that install
  dependencies or mutate shared state isolated.
- Retain complete coverage when splitting tests across CI jobs. Required checks
  must fail when any required job fails or is cancelled. Measure durations when
  tuning the suite, and enable checks against live external services explicitly
  with bounded concurrency and resource use.
- Treat legacy test layouts as historical choices, not structural precedent.
  Move them only as a dedicated change that updates build and test configuration
  together.

## Git history

- Name new branches `<type>/<short-kebab-case-description>`, for example
  `feat/public-api`, `fix/tls-verification`, `refactor/transport`,
  `docs/project-status`, `test/public-workflow`, or `ci/runtime-matrix`. Allowed
  types are `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, `perf`,
  and `chore`. Do not use an agent or tool prefix.
- Use Conventional Commits:
  `<type>[optional scope][!]: <imperative description>`. For every non-trivial
  commit, add a body explaining the motivation, behavioral or design impact,
  important tradeoffs, and verification performed. Add `Refs: #123` or
  `Closes: #123` as appropriate; mark breaking changes with `!` and a
  `BREAKING CHANGE:` footer.
- Use the same Conventional Commit format for pull request titles. Describe
  the final change and choose the type, optional scope, and breaking-change
  marker to match its actual impact.
- Make each commit one coherent, reviewable change that passes its relevant
  checks. Split large work into dependency-ordered commits by behavior or
  architectural layer. Keep unrelated refactors, formatting churn, generated
  output, and behavior changes separate; do not leave `WIP` or `fixup` commits
  in final history.
- Apply the naming rule when creating the next branch. Do not rename an active
  or shared branch without explicit approval.

## Definition of done

- Update tests, public documentation, examples, and package metadata alongside
  the behavior they describe, where applicable.
- Run the documented formatting and quality checks relevant to the change.
  Report exactly what ran and disclose any failure, skipped check, warning,
  or environment limitation. Do not claim a check passed if it did not run.
- Review the diff for accidental API changes, duplicate sources of truth,
  leaked secrets, insecure I/O, stale comments, and unrelated edits.
