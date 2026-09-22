@subagents @draft @SA-07
Feature: Resolve agent definitions and models predictably
  As a user,
  I want explicit agent and model configuration,
  so that delegation does not silently change capabilities or providers.

  @ACC-SA-07-01 @confirmed @compatibility
  Scenario: Publish configured model fallback names without changing the tool schema.
    Given Secretary advertises the "Agent" tool.
    When a model request is prepared.
    Then the optional "model" field retains a stable string schema.
    And the runtime catalog lists the configured fallback list names.
    And an unconfigured name is rejected at launch without selecting a substitute model.
    And fallback list mappings are configured outside the tool invocation schema.

  @ACC-SA-07-02 @confirmed
  Scenario: Resolve an explicit fallback list through configuration.
    Given the fallback list "primary" maps to the available pi model "test-provider/reviewer-model".
    And the selected definition specifies a different available model.
    When the parent launches the agent with "model" set to "primary".
    Then the child uses "test-provider/reviewer-model".
    And the tool result and inspector identify that resolved model.

  @ACC-SA-07-03 @confirmed
  Scenario: Refuse a model value that names no session model or configured list.
    Given no fallback list named "unconfigured" exists.
    When the parent requests an agent with "model" set to "unconfigured".
    Then the tool identifies the unknown fallback list name.
    And no model is selected as a fallback.
    And no child provider request occurs.
    And an empty configured list is refused the same way.

  @ACC-SA-07-04 @proposed
  Scenario: Inherit the parent model when no override is supplied.
    Given the parent uses the available pi model "test-provider/parent-model".
    And the selected definition has no model override.
    When the parent launches the agent without a model argument.
    Then the child uses "test-provider/parent-model".
    And a later change to the parent's model does not change that child's resolved model.

  @ACC-SA-07-05 @proposed
  Scenario Outline: Choose a definition according to scope and trust.
    Given packaged, user, and project definitions all have the name "general-purpose".
    And the project definition is <trust_state>.
    When a new "general-purpose" agent is launched.
    Then the <selected_scope> definition is selected.
    And the inspector identifies the selected definition's source.

    Examples:
      | trust_state                   | selected_scope |
      | in a trusted project          | project        |
      | in a project without trust    | user           |

  @ACC-SA-07-06 @proposed
  Scenario: Prevent a definition from broadening the parent's tool permissions.
    Given the parent is not authorized to use a particular tool.
    And an agent definition requests that tool.
    When a child is initialized from that definition.
    Then the child cannot execute that tool.
    And registering the tool later does not bypass the same restriction.
    And the child cannot invoke delegation or goal-mutation tools.

  @ACC-SA-07-07 @proposed
  Scenario: Keep the saved model and definition when resuming.
    Given a resumable agent has finished with a recorded model and definition.
    And the agent definition file is edited to select a different model.
    When the parent explicitly resumes the saved agent.
    Then the saved definition and model remain selected subject to current permissions and availability.
    And the edited definition applies to newly created agents rather than silently replacing the saved configuration.

  @ACC-SA-07-08 @proposed
  Scenario: Refuse unsupported behavioral configuration.
    Given a custom definition requests nested delegation or a permission override that this release does not support.
    When the definition is validated for launch.
    Then validation reports the unsupported field.
    And the field is not silently ignored or used to grant additional authority.

  @ACC-SA-07-09 @confirmed
  Scenario: Try fallback candidates in order when a model is unavailable.
    Given the fallback list "primary" maps to "test-provider/reviewer-model" and "test-provider/different-model" in that order.
    And the first model reports an availability failure before producing any output.
    When the parent launches the agent with "model" set to "primary".
    Then the run completes with "test-provider/different-model".
    And the agent record and inspector identify the model that actually executed.
    And a later launch skips the recorded unavailable candidate and reports the skip.

  @ACC-SA-07-10 @confirmed
  Scenario: Skip a candidate whose provider has no configured credentials.
    Given the fallback list "primary" maps to "locked-provider/reviewer-model" and "test-provider/different-model" in that order.
    And the provider "locked-provider" declares API-key authentication but has no configured credentials.
    When the parent launches the agent with "model" set to "primary".
    Then the run completes with "test-provider/different-model".
    And the launch reports that "locked-provider/reviewer-model" was skipped for missing credentials.
    And no provider request is made for "locked-provider/reviewer-model".

  @ACC-SA-07-11 @confirmed
  Scenario: Try the next candidate when the provider rejects the configured credentials.
    Given the fallback list "primary" maps to "test-provider/reviewer-model" and "test-provider/different-model" in that order.
    And the first model rejects the configured API key before producing any output.
    When the parent launches the agent with "model" set to "primary".
    Then the run completes with "test-provider/different-model".
    And the agent record and inspector identify the model that actually executed.

  @ACC-SA-07-12 @confirmed
  Scenario: Keep attempted candidates in the failure report when the chain aborts.
    Given the fallback list "primary" maps to "test-provider/reviewer-model" and "test-provider/ghost-model" in that order.
    And the first model reports an availability failure before producing any output.
    And the second candidate cannot be set up.
    When the parent launches the agent with "model" set to "primary".
    Then the run fails.
    And the failure names the first candidate with its availability failure reason.
    And the failure names the second candidate whose setup aborted the chain.
