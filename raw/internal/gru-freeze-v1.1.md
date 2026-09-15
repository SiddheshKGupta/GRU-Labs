GRU
Governed Recurrent Unit
Governed Project Delivery System
Product and Architecture Freeze v1.1
Bring the project. Bring the models and capabilities you already use.
GRU builds the team.
7042154259580

Primary engineering rule: Own the machine. Integrate the commodities. Learn from everything.
Bring the project. Bring the models and capabilities you already use. GRU builds the team.

0. Executive Summary
GRU is a governed AI project-delivery system. It starts from the project, determines the expertise and capabilities required, builds a temporary specialist organization, coordinates that organization through a shared project cognition layer, challenges material decisions independently, and advances project state only when authority and verification obligations are satisfied.
GRU is not intended to be another fixed agent swarm, another coding assistant, another model gateway, or another framework collection. The system is designed as one coherent machine with a small number of GRU-native concepts. Existing open-source systems, research papers and production tools are treated as design inputs and, where appropriate, replaceable infrastructure.
The current foundation candidate is DeepSeek Harness because it already solves substantial execution plumbing: agent loops, sessions, tools, provider/model routing, plugins, workspaces, terminals and a composable web client. GRU should build its own organization, project state, capability intelligence, Minion Mind and Authority & Verification Layer above that chassis. DeepSeek Harness is a foundation hypothesis, not a permanent constitutional dependency.
Escapement v1, Core and Continuum remain valuable research and evidence sources. GRU does not inherit their implementation or architecture by default. Every mechanism must survive comparison against stronger alternatives.
The system will follow a four-way component sourcing decision:
Decision
Meaning
BUILD NATIVE
The mechanism defines GRU's project-delivery semantics or organization model and must speak the GRU domain language directly.
INTEGRATE
The mechanism is commodity infrastructure, has a clean boundary, acceptable licensing, and saves material engineering effort.
INSPIRE + REIMPLEMENT
The external system contains a strong idea, but importing its architecture would create coupling or conflicting semantics.
DEFER / REJECT
The capability is not currently necessary, is too immature, has licensing risk, or adds more complexity than value.

A second product-surface decision is also frozen in this version: GRU should consider an IDE, but GRU should not become an IDE. The universal product surface should be a GRU Workbench. For software projects, the Workbench can expose an IDE mode. For consulting, research, finance and other project classes, the surface can change to the artifacts and tools appropriate to that project.
For the first software profile, the preferred approach is to extend the DeepSeek Harness web client with GRU-native panels plus a lightweight editor layer such as Monaco, rather than forking an entire IDE immediately. A full Code-OSS or Theia-class IDE remains a later evidence-gated option if debugging, extension ecosystems or remote-development features justify the additional weight.

1. Product Identity
1.1 Name
GRU means Governed Recurrent Unit.
The dual meaning is deliberate. GRU is the Project Delivery Manager, and its operating loop resembles a recurrent state update:
Previous Project State
        +
New Evidence
        +
Minion Findings
        +
DRU Challenges
        +
Director Decisions
        ↓
       GRU
        ↓
Updated Project State
        +
Next Delivery Action
1.2 Product line
GRU is an AI Project Manager that builds and runs the expert team your project needs.
1.3 Core philosophy
GRU becomes better at building expert teams, not at pretending to be every expert.
Take the best ideas. Use the strongest chassis. Build one machine.

2. Relationship to Escapement
Escapement is no longer the mandatory technical foundation.
Escapement v1
  evidence from governed delivery
        │
Core / Continuum
  authority, verification, falsification,
  architecture-reduction and research lessons
        │
        ├──────────────┐
        │              │
        ▼              ▼
external research   stronger open-source systems
and standards       and production practice
        │              │
        └──────┬───────┘
               ▼
      architectural selection
               ▼
              GRU
The permanent rule is:
Use the strongest available implementation for the problem. Keep nothing because we built it first.
Escapement contributes lessons such as evidence-backed closure, explicit verification, durable project state, strong-baseline discipline and truthful status. GRU may port, redesign or discard the implementation of those mechanisms.

3. Core Product Thesis
GRU compiles and governs the temporary expert organization required to deliver a project.
PROJECT
   ↓
Understand the intended outcome
   ↓
Define the Project Contract
   ↓
Determine required expertise
   ↓
Find capability gaps
   ↓
Research strongest available capabilities
   ↓
Build / integrate / provision what is required
   ↓
Construct specialist Minions
   ↓
Equip each Minion with a bounded loadout
   ↓
Coordinate through Minion Mind
   ↓
Challenge through DRU
   ↓
Authorize and verify through AVL
   ↓
Project Director decides
   ↓
Deliver
   ↓
Verified episodes improve future organization design
The organization exists because the project requires it. GRU is not attempting to simulate a company for its own sake.

4. Architectural Principles
1.  Project first. The project determines the organization, not the other way around.
2.  One internal language. GRU-native project, task, role, evidence and authority objects are authoritative inside the system.
3.  Replaceable infrastructure. Models, providers, gateways, sandboxes, editors, databases and external tools are implementation choices.
4.  Non-negotiable delivery semantics. Project intent, authority, evidence, verification and truthful state transition are not delegated to an external framework.
5.  Integration over reinvention when the seam is clean. Commodity infrastructure should be reused when it saves meaningful engineering and does not distort GRU.
6.  Inspiration over framework aggregation. Strong ideas from other systems may be reimplemented natively when their runtime assumptions conflict with GRU.
7.  License before adoption. Open source is not one license class. Code, assets, hosted services, trademarks and transitive dependencies are evaluated independently.
8.  Build the smallest coherent mechanism. Native does not mean enormous.
9.  Independent verification is load-bearing. The maker does not become the sole verifier of consequential work.
10.  The Director owns decisions. AVL owns truth. Risk may be accepted. Evidence may not be rewritten.
11.  No foundation is sacred. DeepSeek Harness is the current preferred chassis and remains replaceable if evidence supports migration.
12.  Composition must be tested. Individually strong parts can produce weak or unsafe seams.

5. System Overview
                         PROJECT DIRECTOR
                              User
                               │
                  strategic decisions / risk
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
                GRU                         DRU
        Project Delivery Manager    Shadow Project Manager
                 │                           │
                 └─────────────┬─────────────┘
                               ▼
                        DR. NEFARIO
                   Chief Capability Engineer
                               │
                        equips Minions
                               │
                               ▼
                            MINIONS
                     project specialists
                               │
                               ▼
                         MINION MIND
                  shared project cognition
                               │
                               ▼
                              AVL
                 Authority & Verification Layer
                               │
                   GRU <-> FOUNDATION CONTRACT
                               │
                               ▼
                     DEEPSEEK HARNESS
                    current execution chassis
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
       Models               Tools / MCPs        Workspace / Terminal
          │                    │                    │
          └────────────────────┼────────────────────┘
                               ▼
                       external environment

6. The GRU Organization
Component
Role
Project Director / Owner
The user. Final strategic authority, priorities, constraints, risk acceptance and go/no-go decisions.
GRU
Project Delivery Manager. Plans, staffs, delegates, coordinates, integrates and proposes closure.
DRU
Shadow Project Manager. Independent adversarial counterpart that searches for failure, missing assumptions and contradictory evidence.
Dr. Nefario
Chief Capability Engineer. Discovers, evaluates, provisions, repairs and optimizes tools, skills, MCPs, models, providers, gateways, datasets and deterministic analyzers.
Minions
Dynamically assembled domain specialists with bounded role-specific capability loadouts.
Minion Mind
Shared project cognition. Maintains project state, tasks, claims, evidence, capability status and disagreement without broadcasting everything to everyone.
AVL
Authority & Verification Layer. Governs project consequences, authority, evidence obligations, verification, state transitions, closure and promotion.

7. Project Director
The Project Director owns decisions. AVL owns truth.
The Director may:
set project intent and priorities;
approve or reject material alternatives;
alter scope and sequencing;
accept residual risk;
authorize consequential actions;
stop, pause or redirect the project.
The Director may not convert a failed or missing verification into a passing result. A valid override records both truths:
Verification: FAIL
Director Decision: PROCEED
Residual Risk: ACCEPTED BY DIRECTOR
not:
Verification: PASS

8. GRU: Project Delivery Manager
GRU:
interprets project intent and creates the Project Contract;
creates milestones, work breakdown, dependencies and priorities;
determines which specialist roles are needed and when;
delegates work and coordinates Minion collaboration;
monitors delivery state and replans when evidence changes;
integrates specialist outputs while preserving meaningful disagreement;
escalates material blockers and strategic decisions;
proposes closure only after AVL obligations are satisfied.
8.1 Domain persona
The management function is stable while the operating context changes.
Project type
GRU persona
Software / Engineering
Engineering Manager / CTO
Investment / Algorithmic Trading
Fund Manager
Scientific Research
Principal Investigator
Consulting
Engagement Manager / Partner
Product
Product Lead
Security
Security Program Director

9. DRU: Shadow Project Manager
GRU asks: How do we deliver this? DRU asks: How does this fail?
DRU is not a one-shot self-critique prompt. It is a persistent independent project role.
DRU:
searches for contradictory evidence;
identifies assumptions carrying a plan or recommendation;
produces the strongest plausible failure case;
identifies the strongest alternative;
requests independent specialist review when evidence is narrow;
preserves residual disagreement rather than manufacturing consensus;
can summon temporary red-team Minions for high-materiality decisions.
GRU does not choose which evidence DRU is allowed to see. Both receive appropriate projections from Minion Mind according to role and authority.

10. Bounded GRU-DRU Debate
Debate seeks common ground, but disagreement has a deadline.
Material decisions use five core questions:
Question
Purpose
Q1 - Objective
What are we actually trying to achieve?
Q2 - Evidence
What supports the proposal and what contradicts it?
Q3 - Assumptions
What must be true for this decision to work?
Q4 - Risk / Alternative
What is the strongest failure case and strongest alternative?
Q5 - Decision
What should we do, what remains uncertain, and what would change the decision?

Each question receives one bounded cycle:
GRU position
    ↓
DRU challenge
    ↓
relevant Minion evidence
    ↓
GRU final response
    ↓
DRU disposition
ACCEPT or RESIDUAL OBJECTION
Valid outcomes:
Outcome
Action
CONSENSUS
Proceed subject to AVL.
CONDITIONAL CONSENSUS
Encode explicit conditions and proceed when satisfied.
RESIDUAL DISAGREEMENT
Stop internal debate and escalate to the Project Director.

A closed question reopens only when new material evidence appears.

11. Organization Compiler
Organization Compilation is the mechanism that converts a project into the team required to deliver it.
PROJECT CONTRACT
      ↓
required outcomes
      ↓
work and risk decomposition
      ↓
required expertise
      ↓
available expertise / capability gaps
      ↓
Nefario capability acquisition
      ↓
Minion roles and loadouts
      ↓
team topology
      ↓
verification responsibilities
      ↓
TEMPORARY PROJECT ORGANIZATION
The Organization Compiler should initially be transparent and rule-guided. Learned staffing policy comes later, after enough verified delivery episodes exist.

12. Minions
A Minion is a logical specialist role, not a specific model or process.
MINION
=
ROLE
+ DOMAIN CONTEXT
+ MODEL ROUTE
+ SKILLS / PLUGINS
+ TOOLS / MCPs
+ LIBRARIES / REPOS
+ INFORMATION SOURCES
+ DETERMINISTIC INTELLIGENCE
+ AUTHORITY
+ BUDGET
+ VERIFICATION CONTRACT
A Minion is bound to a role and delivery contract, not to a model, provider, gateway or toolchain.
A Security Minion may use one model today and another tomorrow while preserving the same role contract.
12.1 Independent verification
The implementing Minion cannot be the sole verifier of consequential work. GRU assigns an independent verification role where materiality requires it.

13. Minion Mind
Minion Mind is the shared project cognition fabric.
MINION MIND

Project State
Task Graph
Blackboard
Knowledge + Provenance
Claim Graph
Decision Register
Evidence
Capability Graph
Minion State
Event History
Verified Episodes
13.1 One shared view, not one shared opinion
Minion Mind preserves disagreement. It does not collapse the team into one opinion.
A claim can be:
SUPPORTED
CONTESTED
REJECTED
SUPERSEDED
UNVERIFIED
with explicit supporting and contradicting evidence.
13.2 Context projection
No agent receives the entire project history by default.
MINION MIND
     ↓
role + task + dependency + freshness + materiality + authority
     ↓
CONTEXT COMPOSER
     ↓
MINION OBSERVABLE STATE
Private working context remains local to a Minion unless a meaningful state transition, claim, decision or evidence object is published.

14. AVL: Authority & Verification Layer
AVL is GRU's constitutional layer.
GRU has managerial authority. AVL has constitutional authority.
AVL owns:
ProjectAction semantics;
ProjectConsequence normalization;
AuthorityRequirement evaluation;
EvidenceRequirement evaluation;
VerificationContract status;
state-transition eligibility;
truthful closure;
DirectorOverride recording;
learning and promotion eligibility.
14.1 Consequence semantics
Different technical routes that produce the same material project consequence should carry the same project-delivery obligation.
ACTION
   ↓
PROJECT CONSEQUENCE
   ↓
AUTHORITY OBLIGATION
   ↓
EVIDENCE OBLIGATION
   ↓
INDEPENDENT VERIFICATION
   ↓
STATE TRANSITION
   ↓
TRUTHFUL CLOSURE
14.2 Information is not authority
Untrusted information can influence reasoning. It cannot grant itself permission.
14.3 Secrets
Minions receive capability handles and model routes, not raw secrets, wherever the underlying substrate allows brokered credentials.

15. Dr. Nefario: Chief Capability Engineer
Nefario owns two related domains.
15.1 Capability Engineering
skills
plugins
MCPs
GitHub repositories
libraries
APIs
datasets
browsers
deterministic analyzers
code intelligence tools
15.2 Intelligence Engineering
models
providers
gateways
local runtimes
reasoning modes
context capacities
model capabilities
route health

Nefario's operational loop:
NEED
 ↓
DISCOVER
 ↓
QUARANTINE
 ↓
UNDERSTAND
 ↓
EVALUATE
 ↓
LICENSE / SECURITY GATE
 ↓
PROVISION
 ↓
SMOKE TEST
 ↓
HEALTH VERIFY
 ↓
ADMIT
 ↓
ASSIGN
 ↓
MONITOR
 ↓
REPAIR / REPLACE / RETIRE
Minions consume capabilities. Nefario discovers, admits, provisions and maintains them.

16. Capability Readiness
A capability is not ready because it appears in a catalogue.
Health layer
Question
Install
Did dependencies install successfully?
Startup
Does the process or service start?
Protocol
Does CLI / API / MCP communication work?
Semantic
Does a representative smoke test produce the expected class of result?
Resource
Is latency, memory, cost and runtime footprint acceptable?
Security
Are permissions, credentials and configuration boundaries intact?

Only capabilities with sufficient operational readiness become eligible for Minion loadouts.

17. Component Sourcing Doctrine
GRU does not choose between "build everything" and "integrate everything." Every component gets an explicit disposition.
17.1 BUILD NATIVE
Build natively when the mechanism defines the GRU machine:
Project Contract and project state;
Gru;
Dru;
Nefario's decision logic;
Organization Compiler;
Minion role and loadout semantics;
Minion Mind;
AVL project-consequence semantics;
bounded debate;
verified organizational learning;
GRU observability semantics.
17.2 INTEGRATE
Integrate when the capability is infrastructure with a clean boundary:
model-provider SDKs and protocols;
DeepSeek Harness execution plumbing;
databases;
Git;
containers and process isolation;
MCP protocol libraries;
HTTP / WebSocket / OAuth libraries;
language servers, Tree-sitter and compiler tooling;
OpenTelemetry;
editor components such as Monaco.
17.3 INSPIRE + REIMPLEMENT
Reimplement the useful mechanism natively when importing the external system would bring conflicting architecture:
Munder Difflin supervisor, mailbox and visual-office ideas;
OneManCompany dynamic organization / Talent concepts;
Magentic-One task/progress ledgers and replanning;
AgentVerse / AutoAgents dynamic expert recruitment;
Axis / co-scientist independent challenge and specialist debate;
SkillFoundry-style capability extraction and validation.
17.4 DEFER / REJECT
Defer when:
the requirement has not appeared;
the integration duplicates an existing layer;
license or asset terms are incompatible;
the component is too immature for the intended boundary;
the maintenance burden exceeds the expected value.

18. Component Decision Record
Every meaningful external dependency must have a Nefario decision record.
COMPONENT DECISION

Problem:
What are we solving?

GRU Requirement:
What property is actually required?

Candidates:
A
B
C
Native implementation

License / Asset Terms:
...

Integration Cost:
...

Architecture Coupling:
...

Maintenance Risk:
...

Security Surface:
...

Overlap:
...

Recommendation:
BUILD NATIVE / INTEGRATE / OPTIONAL ADAPTER / INSPIRE + REIMPLEMENT / DEFER

Reason:
...

19. Licensing and Admission Gate
Licensing is a product engineering concern, not an end-of-project legal clean-up.
Every component record should track:
SPDX / stated license
source URL and pinned commit/version
commercial-use status
modification / redistribution obligations
NOTICE / attribution obligations
patent terms
separately licensed assets
trademark constraints
hosted-service terms
transitive dependency risk
SBOM where available
19.1 Default engineering posture
License class
Default posture
MIT / BSD / ISC / Apache-2.0
Generally admissible, subject to notices and dependency review.
MPL / LGPL / weak copyleft
Architecture and legal review before embedding or redistribution.
GPL
Review before embedding or distributing as part of the product.
AGPL
Avoid in core unless deliberately approved.
BSL / SSPL / custom source-available
Review before use.
Non-commercial assets/code
Do not use in a commercial distribution.
No license / unknown
Quarantine. Do not copy.

This is an engineering admission policy, not legal advice.
19.2 Code, assets, service terms and trademarks are separate
Munder Difflin is a useful reminder: its code is MIT, while its bundled pixel-art assets have separate terms. GRU must audit the complete component surface rather than assuming a repository-level license covers every asset.
The current GRU / DRU / Nefario / Minion theme is an internal product and research codename. Public commercial branding and original visual characters remain a separate future decision.

20. Current Component Decision Map
This table is directional, not permanent. Nefario must re-verify the exact version and license before adoption.
Area
Candidate
Current disposition
Reason
Agent execution chassis
DeepSeek Harness
INTEGRATE AS CURRENT BASE
Strong plugin/session/tool/provider infrastructure. MIT. Developer preview means isolate GRU semantics from upstream internals.
Provider/model execution
DeepSeek Harness + its provider abstraction
INTEGRATE
Already separates provider and model and supports configurable routes. Avoid a duplicate model transport layer.
Minimal alternate runtime
Pi
REFERENCE / BENCHMARK
Useful architecture reference. Do not add a second runtime until a requirement justifies it.
Project planning
Magentic-One / AutoGen
INSPIRE + REIMPLEMENT
Task/progress ledger and replanning concepts are valuable; importing a second orchestration framework is not.
Dynamic organization
OneManCompany
INSPIRE + REIMPLEMENT
Strong organizational ideas, but GRU should own project-specific organization semantics.
Agent office / messaging
Munder Difflin
INSPIRE + SELECTIVE PATTERNS
Good persistent office and PTY-agent patterns. Build original GRU visual assets.
Capability discovery
SkillFoundry-like systems
INSPIRE + REIMPLEMENT
Nefario needs a broader cross-domain lifecycle and operational health model.
SaaS tool ecosystem
Composio-class platforms
OPTIONAL ADAPTER
Useful for external auth/tool reach if the need appears. Do not make Nefario depend on one tool marketplace.
MCP catalogue
Docker MCP Registry-class catalogues
INTEGRATE AS SOURCE
Useful discovery source. GRU still owns admission, provisioning and health.
Sandbox
NVIDIA OpenShell
STRONG OPTIONAL BACKEND
Apache-2.0, agent-focused isolation, policy and credential handling. Alpha status requires pinning and testing.
Authorization evaluator
Cedar
CANDIDATE DEPENDENCY
Apache-2.0 and mature policy language. AVL consequence semantics remain GRU-native.
Agent governance tooling
Microsoft Agent Governance Toolkit
CANDIDATE INTEGRATION / BENCHMARK
MIT, cross-framework governance and conformance ideas. Integrate only where it reduces AVL plumbing without replacing AVL semantics.
Gateway
OpenRouter / LiteLLM / Portkey-class routes
ROUTE, NOT CORE
Let users bring gateways. Do not stack gateway frameworks without a concrete requirement.
Project cognition
Existing memory / blackboard systems
BUILD NATIVE
Minion Mind is central to GRU coherence.
Project constitution
Generic policy systems
BUILD GRU SEMANTICS
AVL's project-consequence, evidence and closure model is defining GRU machinery.
Pixel office UI
External office assets
INSPIRE ONLY
Build original GRU visuals and interaction model.

21. DeepSeek Harness as the Current Foundation
DeepSeek Harness is the current preferred chassis because it already provides substantial plumbing GRU would otherwise need to build before testing its actual product thesis.
Relevant capabilities include:
agent loop and tool execution;
plugin-oriented composition;
durable sessions and replay-oriented state;
provider/model routing;
configurable providers, credentials and custom endpoints;
terminals and local filesystem capabilities;
persistent workspace records;
browser client with plugin/slot composition;
model settings UI;
CLI and web surfaces.
21.1 Boundary
GRU builds on DeepSeek Harness. GRU does not become a DeepSeek Harness skin.
GRU-native packages should remain conceptually separate:
packages/

  upstream / foundation-derived
    harness execution
    sessions
    llm
    tools
    terminal
    web shell

  GRU-native
    gru-core
    gru-project
    gru-organization
    gru-mind
    gru-avl
    gru-nefario
    gru-capabilities
    gru-model-intelligence
    gru-verification
    gru-learning
    gru-workbench
21.2 Upstream policy
If the project is derived from DeepSeek Harness history:
origin   → GRU repository
upstream → deepseek-ai/deepseek-harness
Upstream changes are reviewed, tested and selectively adopted. They are not blindly merged.
21.3 Foundation replacement
DeepSeek Harness remains a hypothesis. If a materially better chassis appears, GRU compares it against a defined base-selection scorecard before migrating.

22. Foundation Selection Scorecard
Dimension
Question
Runtime
Does it execute the Minion workload classes GRU needs?
Extensibility
Can GRU extend it without invasive patches?
Events
Can Minion Mind and AVL reconstruct material activity?
Models
Does it support heterogeneous provider/model routes?
Tools
Can tool calls be observed, constrained and extended?
Sessions
Are persistence, resume and fork semantics sufficient?
Workspace
Can project directories and sessions be represented cleanly?
Isolation seam
Can execution sit behind a sandbox/reference monitor?
Capability lifecycle
Can Nefario add/remove capabilities safely?
Observability
Are material runtime events externally visible?
Performance
What latency and resource overhead does it impose?
Maintainability
What is the cost of keeping pace with upstream?
License
Is the exact version compatible with intended distribution?
GRU fit
How much translation/glue is required?

23. Bring-Your-Own-Model and Route Fabric
GRU does not decide which AI ecosystem the user must belong to.
A model is not the route. GRU treats the execution channel as a richer object.
ExecutionRoute
=
Direct / Gateway
+ Provider
+ Model
+ Credential Reference
+ Endpoint
+ Protocol
+ Capability Profile
+ Observed Health
23.1 Route classes
direct model provider;
multi-provider gateway;
enterprise/private gateway;
custom compatible endpoint;
local runtime;
future route type through an adapter.
23.2 Health is multidimensional
Dimension
Example states
Credential
CONFIGURED, MISSING, INVALID, EXPIRED, REVOKED, UNKNOWN
Route
HEALTHY, DEGRADED, RATE_LIMITED, UNREACHABLE, DOWN
Model availability
AVAILABLE, NOT_ENTITLED, NOT_FOUND, TEMPORARILY_UNAVAILABLE, UNKNOWN
Capability conformance
tool use, streaming, structured output, reasoning, vision, context capacity

23.3 Discovery
ADD PROVIDER / KEY / ENDPOINT
        ↓
store secret write-only
        ↓
probe route
        ↓
discover models where protocol supports it
        ↓
record model metadata
        ↓
run lightweight conformance probes
        ↓
READY / DEGRADED / UNAVAILABLE
23.4 User control modes
Mode
Behavior
Manual
Director selects exact model and route.
Role Policy
Director maps GRU, DRU, Minion roles or task classes to preferred routes.
AUTO
GRU/Nefario chooses from eligible routes using capability, health, task fit, cost, latency, privacy, quota and verified historical performance. The route choice remains explainable.

24. Capability Provisioning Backends
GRU owns the lifecycle, not every installer.
Capability Manifest
        ↓
GRU Provisioner
        ↓
backend selection
   ├── isolated Python environment
   ├── Node environment
   ├── container
   ├── verified executable
   └── remote service
        ↓
install / configure
        ↓
start
        ↓
smoke test
        ↓
register
Candidate implementation technologies can include uv, pnpm/npm, Docker/Podman, local processes and external services. These are replaceable backends under a GRU capability lifecycle.
25. Should GRU Become an IDE?
Decision
Consider IDE capabilities. Do not define GRU as an IDE.
The product should be a GRU Workbench that adapts to the project class. A software project receives an IDE-like delivery surface. A consulting engagement may emphasize documents, data tables, workflows and dashboards. A scientific project may emphasize papers, notebooks, datasets and experiments. An investment project may emphasize research, data, backtests and risk views.
This preserves GRU's project-delivery identity instead of narrowing the system into a coding product.
25.1 Why an IDE-like surface is valuable for software
Software delivery benefits from keeping these views together:
Project / Minion office
Task graph
File tree
Editor
Diff
Terminal
Git state
Tests
Evidence
AVL approvals
Model / capability health
The Workbench can therefore become the place where the Project Director sees both the organization and the actual work product.
25.2 Why not build a full IDE in v0.1
A full IDE adds enormous scope:
debugger architecture;
extension marketplace compatibility;
language server management;
remote-development semantics;
terminal and shell integration;
editor state persistence;
source control UI;
plugin compatibility;
cross-platform desktop packaging.
GRU does not need all of that to validate its organization and governance thesis.
25.3 Recommended first implementation
Use the existing DeepSeek Harness web client and workspace infrastructure as the shell, then add GRU-native web plugins.
DeepSeek Web Shell
        │
        ├── GRU Office / Mission Control
        ├── Minion Mind
        ├── AVL / Evidence
        ├── Nefario Lab
        ├── Model & Route Health
        ├── Workspace File Tree
        ├── Monaco Editor
        ├── Diff Viewer
        └── Terminal
DeepSeek Harness already has persistent workspace records, terminal packages and a browser plugin/slot system. Community work also demonstrates that file trees, previews and diff-oriented UI can be added as plugins without redefining the whole application. This makes an incremental GRU Workbench more sensible than adopting a full second IDE platform immediately.
25.4 Editor candidates
Candidate
License / posture
GRU decision
Monaco Editor
MIT
Preferred v0.1 editor component. Lightweight enough to embed into the GRU Workbench without adopting a whole IDE.
Code - OSS
MIT source repository; Microsoft VS Code distribution has separate product licensing
Later full-IDE candidate. Very capable but large, high-maintenance and likely excessive before GRU needs the complete edit-build-debug ecosystem.
Eclipse Theia
Framework uses EPL-2.0 / GPL-2.0 with Classpath Exception; Theia IDE packaging has separate MIT elements
Evaluate later with explicit license review. Strong purpose-built IDE framework but introduces another platform and license surface.
Zed
Primarily GPL-3.0-or-later, with Apache-2.0 components
Inspiration / external editor integration, not preferred embedded base.

25.5 Longer-term Workbench modes
GRU WORKBENCH

SOFTWARE MODE
  editor / terminal / diff / tests / repo graph

RESEARCH MODE
  papers / notes / evidence / experiments / datasets

CONSULTING MODE
  documents / workflows / data / dashboards / review packs

INVESTMENT MODE
  filings / models / datasets / backtests / risk / decisions
The Workbench should expose the project rather than force every project into a code editor.

26. GRU Workbench and 8-bit Office
The 8-bit office remains an observability metaphor, not the runtime itself.

Figure 1. Internal conceptual GRU observability / project-office mockup. Visual language is not final product branding.
The main software-mode surface could eventually combine:
┌───────────────────────┬──────────────────────────────────────┐
│ GRU PROJECT OFFICE    │ WORKBENCH                            │
│                       │                                      │
│ Gru                    │ File / Document / Notebook / Editor │
│ Dru                    │                                      │
│ Nefario                │ Diff / Output / Preview             │
│ Active Minions         │                                      │
│                       │                                      │
├───────────────────────┼──────────────────────────────────────┤
│ MINION MIND / AVL     │ TERMINAL / TESTS / EVENTS            │
│ claims / evidence     │                                      │
│ risks / approvals     │                                      │
└───────────────────────┴──────────────────────────────────────┘
The office answers "who is doing what and why?" The Workbench answers "what is being changed or produced?" AVL answers "what is authorized and verified?"

27. Prior Art and Inspiration
GRU should openly document where ideas came from. The contribution is not pretending that familiar pieces are new.
Reference
What GRU studies
Current posture
Munder Difflin
persistent multi-agent office, real terminal-agent processes, mailboxes, visible agent activity
Inspiration and selective technical patterns; do not reuse separately licensed art assets.
OneManCompany
dynamic organization, talent packaging, AI workforce concepts
Inspiration for Organization Compiler and capability packaging.
Magentic-One / AutoGen
supervisor planning, task/progress ledgers, stall detection, replanning
Reimplement the minimum GRU planning semantics.
AgentVerse / AutoAgents
dynamic expert recruitment
Prior art for staffing. Benchmark against it rather than claim the idea.
Google Co-Scientist / debate systems
specialized roles, independent review, ranking, debate
Prior art and design reference for domain-shaped teams.
Axis-style cross-examination
independent devil's advocate around project outputs
Reference for DRU, while DRU remains a persistent project-level role.
SkillFoundry-like systems
extracting usable capability from repositories, APIs, docs and papers
Design input for Nefario.
Docker MCP Registry / tool ecosystems
catalogues, packaging, discoverability
Discovery sources, not GRU authority.
Cedar / governance toolkits
authorization and policy evaluation
Candidate plumbing below AVL semantics.
OpenShell
sandboxing, network policy and credential isolation
Optional enforcement backend.
Escapement v1 / Core / Continuum
governed delivery, evidence, verification, truthful closure, trust boundaries, strong-baseline reduction
Research lineage, not mandatory code lineage.

28. Security and Constitutional Principles
Untrusted intelligence never receives ambient authority by default.
A model may request authority. It does not grant itself authority.
Raw credentials should not be inserted into Minion context when a brokered route is possible.
The implementing Minion is not the sole verifier of its consequential work.
Capability discovery does not imply installation.
Installation does not imply authorization.
Authorization does not imply verification.
Verification status cannot be rewritten by managerial preference.
Disagreement is preserved when material.
Debate is finite.
External runtimes and policy engines are replaceable infrastructure.
GRU project-delivery semantics remain independent from any one substrate.

29. Learning and Organizational Evolution
GRU should improve from verified delivery episodes, not from self-assertion.
Questions worth learning:
Which specialist roles were useful for a project class?
Which team topology produced better verified outcomes?
Which model routes worked best for each role or task?
Which tools and deterministic analyzers improved outcomes?
Which capability combinations conflicted?
Which operational failures required fallbacks?
Which debate objections predicted real failures?
Which repeated judgment-heavy procedures can be safely determinized?
A proposed organizational change should follow:
historical verified episodes
        ↓
proposal
        ↓
prospective evaluation
        ↓
independent verification
        ↓
PROMOTE / REJECT
        ↓
monitor
        ↓
RETAIN / ROLL BACK
The proposer cannot weaken the verification criteria that decide whether its own proposal is promoted.

30. Verified Determinization
Use intelligence where judgment is required. Use deterministic machinery wherever evidence shows judgment is no longer necessary.
Repeated, stable and independently verified agentic procedures may be converted into deterministic workflows or tools.
A determinized procedure should carry an environment/version digest and a lifecycle such as:
ACTIVE
STALE
SUPERSEDED
When stale, GRU falls back to agentic execution, collects new evidence and re-evaluates the deterministic procedure.

31. v0.1 Scope
The first implementation should prove GRU's architecture without attempting to build the future platform at once.
31.1 Include
one local project
one Project Director
one GRU
one DRU
one Nefario
3-5 Minions
one Minion Mind
AVL v0
DeepSeek Harness foundation
2-3 model/provider routes
basic capability provisioning
one independent verification flow
read-only / lightweight GRU Workbench
software profile first
For software mode, the Workbench may include:
project office and role state;
task graph;
file tree;
Monaco editor / preview;
diff viewer;
terminal;
tests/evidence;
AVL approvals;
route and capability health.
31.2 Explicitly defer
giant swarm;
cross-machine federation;
24/7 unattended autonomous operation;
full Code-OSS fork;
extension marketplace compatibility;
complete enterprise IAM;
learned organization routing before data exists;
autonomous self-modification;
dozens of providers merely for coverage;
complex formal policy engine before AVL v0 proves the required semantics;
production-grade distributed Minion Mind before a local implementation proves the data model.

32. Validation Program
GRU should prove mechanisms individually and then test their seams.
32.1 Core experiments
1.  Organization Compilation: Does project-derived staffing beat a fixed generic team on heterogeneous tasks?
2.  DRU value: Does independent challenge improve material decisions enough to justify its cost?
3.  Minion Mind projection: Does structured project cognition reduce duplicated/stale context compared with transcript sharing?
4.  AVL consequence enforcement: Can the same material consequence reached through different technical routes receive equivalent authority/evidence treatment?
5.  Nefario readiness: Does capability health gating reduce broken-tool failures compared with catalogue-only availability?
6.  Model route selection: Does role/task-aware routing improve quality, cost or reliability versus fixed-model use?
7.  Workbench value: Does an integrated project-delivery surface reduce context switching without becoming a second product that distracts from GRU's core thesis?
32.2 Composition conformance
Every integrated component must also be tested at seams:
GRU <-> DeepSeek Harness
AVL <-> tool execution
AVL <-> sandbox
Nefario <-> external capability
Minion <-> model route
Minion Mind <-> context projection
Workbench <-> project state
The question is not only whether each component works, but whether the combined system preserves GRU's required invariants.

33. Working Repository Direction
Illustrative package boundaries:
packages/
├── gru-core/
├── gru-project/
├── gru-organization/
│   ├── gru/
│   ├── dru/
│   ├── nefario/
│   └── minions/
├── gru-mind/
├── gru-avl/
├── gru-capabilities/
├── gru-model-intelligence/
├── gru-verification/
├── gru-learning/
├── gru-workbench/
└── foundation-adapters/
    └── deepseek-harness/
If GRU is derived directly from the DeepSeek Harness codebase, preserve upstream package boundaries wherever practical and place GRU semantics in clearly named packages. Avoid scattering GRU policy through unrelated upstream packages.

34. Freeze Boundary
Frozen in v1.1
Still provisional / evidence-gated
GRU as Governed Recurrent Unit and Project Delivery Manager
Exact final public brand and trademarks
Project Director as final strategic decision-maker
Exact permissions UX
Director owns decisions; AVL owns truth
Exact policy-evaluation technology
DRU as persistent independent Shadow Project Manager
Exact model and red-team staffing policy
Five-question bounded debate
Materiality thresholds and tuned budgets
Dr. Nefario as Chief Capability Engineer
Exact search/ranking algorithms
Capability Intelligence + Capability Operations
Exact provisioning backend mix
Minions as dynamic project specialists
Exact Minion schema and recursion policy
Organization Compilation
Learned staffing policy
Minion Mind as shared project cognition
Database, graph and retrieval technologies
AVL as GRU constitutional layer
Cedar / AGT / other policy plumbing
BYOK provider/model/gateway routes
Exact provider inventory
Separate credential, route and model health
Probe schedules and scoring algorithms
Component sourcing doctrine
Individual component decisions can change
License gate before adoption
Final legal policy and commercial licensing review
DeepSeek Harness as current preferred chassis
Long-term foundation and upstream version
GRU Workbench as universal project surface
Final UI framework and desktop packaging
IDE capabilities as a software-mode module, not product identity
Monaco vs later Code-OSS/Theia migration
Original GRU UI/assets for any commercial distribution
Final art direction
Verified organizational evolution
Learning algorithm
Verified determinization as future research
Compilation mechanism and thresholds

35. Team Rules
Do not keep Escapement code because it is ours.
Do not replace strong infrastructure merely to claim GRU built everything.
Do not integrate another framework if it creates a second internal ontology for the same concept.
Before native implementation, identify the strongest existing implementation and understand why it is insufficient.
Before integration, verify license, assets, security, maintenance and architectural coupling.
Prefer a clean dependency or adapter over a deep fork.
When a fork is necessary, preserve upstream traceability.
Treat provider/model selection as routes, not hardcoded model names.
Treat capability installation and health as product functionality.
Treat project state, evidence and authority as first-class objects.
Keep debate bounded.
Preserve residual disagreement.
Require independent verification for consequential closure.
Test seams, not only components.
Measure whether GRU builds better teams before claiming it does.

36. Final Frozen Thesis
GRU is a governed AI Project Manager that dynamically builds the expert organization a project requires, equips that organization with the strongest justified capabilities available, coordinates it through shared project cognition, challenges it through an independent Shadow Project Manager, and advances project state only through explicit authority and verification.
The Director decides. GRU delivers. DRU challenges. Nefario equips. Minions specialize. Minion Mind connects and remembers. AVL governs.
Own the machine. Integrate the commodities. Learn from everything.

37. Primary Technical References for This Freeze
The following are reference inputs, not endorsements that GRU should integrate every project listed.
DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
DeepSeek Harness workspace subsystem: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workspace.md
DeepSeek Harness web client architecture: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client
DeepSeek Harness provider-routed adapter decision: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-14-provider-routed-llm-adapters.md
Munder Difflin: https://github.com/chaitanyagiri/munder-difflin
OneManCompany: https://github.com/1mancompany/OneManCompany
Microsoft AutoGen / Magentic-One: https://github.com/microsoft/autogen
Microsoft Agent Governance Toolkit: https://github.com/microsoft/agent-governance-toolkit
Cedar: https://github.com/cedar-policy/cedar
NVIDIA OpenShell: https://github.com/NVIDIA/OpenShell
Docker MCP Registry: https://github.com/docker/mcp-registry
Monaco Editor: https://github.com/microsoft/monaco-editor
Code - OSS: https://github.com/microsoft/vscode
Eclipse Theia: https://github.com/eclipse-theia/theia
Zed: https://github.com/zed-industries/zed
License notes verified during this freeze
DeepSeek Harness: MIT.
Munder Difflin source code: MIT; bundled pixel-art assets have separate licensing and must be reviewed independently.
OneManCompany: Apache-2.0.
AutoGen code: MIT.
Microsoft Agent Governance Toolkit: MIT.
Cedar: Apache-2.0.
NVIDIA OpenShell: Apache-2.0.
Docker MCP Registry: MIT.
Monaco Editor: MIT.
Code - OSS source repository: MIT; the Microsoft Visual Studio Code distribution is separately licensed.
Eclipse Theia framework: EPL-2.0 or GPL-2.0 with Classpath Exception; specific Theia distribution packages may carry different licenses and require component-level review.
Zed: primarily GPL-3.0-or-later, with Apache-2.0 components where marked.
Licenses must be re-verified against the exact pinned version before code or assets are adopted.
