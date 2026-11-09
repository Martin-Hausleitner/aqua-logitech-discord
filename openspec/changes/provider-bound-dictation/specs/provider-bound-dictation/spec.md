## ADDED Requirements

### Requirement: New starts require a fresh observed idle provider

The controller SHALL check the existing Watch connection before adopting a new local toggle/PTT start. After asynchronous focus capture it SHALL obtain a same-connection snapshot generated at or after the request and recheck the latest state before Fn. A monotonic 150 ms limit SHALL reject a missing or delayed observation; it SHALL NOT impose a sleep after a valid response. This is observational admission and SHALL NOT be represented as an atomic provider lease claim.

#### Scenario: Provider is already recording or its state is unknown

- **WHEN** a new idle start sees an active, disconnected, malformed or degraded provider observation
- **THEN** it SHALL leave the existing recording unaffected and emit no Fn or initial Return.

#### Scenario: State changes while capture or the status request is pending

- **WHEN** a newer active/unknown frame, changed connection, expired deadline or cancelled generation supersedes the earlier idle observation
- **THEN** the pending start SHALL be discarded without reviving input from a late response.

### Requirement: Denied starts have no repair or input side effect

The controller SHALL retain capture failure metadata locally until final admission succeeds. A denied start SHALL discard only its local owner, generation and proof and SHALL NOT post Fn-down, Fn-up, Return, invoke emergency input cleanup or dispatch repair. Capture failure reporting for an otherwise admitted start SHALL retain the existing route policy.

#### Scenario: Capture fails before provider admission is denied

- **WHEN** capture fails and the final provider observation is active, unknown or timed out
- **THEN** the result SHALL be a suppressed start with no repair dispatch or input event.

#### Scenario: A valid start has a capture failure

- **WHEN** final admission succeeds but capture failed
- **THEN** the existing capture-failure reporting policy SHALL apply without changing the recording route.

### Requirement: Production nonempty text is bound to lifecycle completion

Production settle and transcript selection SHALL require an accepted lease inside the start/stop window, its completion after stop and an exact history session match. Existing source, line, size, hash, ambiguity and history checks SHALL remain enforced. Missing proof SHALL NOT fall back to timestamp-only Return. Window correlation SHALL NOT be called a causal input acknowledgement.

#### Scenario: A later unrelated recording adds fresh history

- **WHEN** there is no accepted lease in the start/stop window but a later recording completes
- **THEN** its history SHALL NOT authorize completion or Return for the earlier mouse run.

#### Scenario: Accepted recording completes with matching history

- **WHEN** the accepted lease has a valid post-stop completion and matching fresh history session
- **THEN** the existing native text, field, caret and send-readiness proof SHALL remain required before Return.

### Requirement: Existing stop and processing semantics are preserved

Normal owned stops SHALL bypass new-start admission. The front stop SHALL retain its verified Return request, the back stop SHALL retain no automatic Return, and explicit processing follow-ups SHALL retain their single-submit behavior. The empty completion wrapper SHALL preserve its existing terminal no-Return result. Legacy helper calls without strict binding SHALL remain best-effort and SHALL NOT weaken production callers.

#### Scenario: Rear stop or empty completion

- **WHEN** an owned recording is stopped with the rear button or completes with no text
- **THEN** the established no-automatic-Return policy SHALL remain in effect.

#### Scenario: Explicit short processing follow-up

- **WHEN** a short follow-up requests submission while the owned recording is being processed
- **THEN** it SHALL retain the same run and require completed text/native proof before the existing one-shot Return.
