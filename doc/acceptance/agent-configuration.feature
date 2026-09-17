@subagents @draft @SA-07
Feature: Resolve agent definitions and models predictably
  As a user,
  I want explicit agent and model configuration,
  so that delegation does not silently change capabilities or providers.

  @ACC-SA-07-01 @confirmed @compatibility
  Scenario: Preserve Claude Code's model alias schema.
    Given Secretary advertises the "Agent" tool.
    When the model input schema is inspected.
    Then the optional "model" field permits exactly these values:
      | value  |
      | sonnet |
      | opus   |
      | haiku  |
      | fable  |
    And arbitrary provider-qualified model identifiers are not accepted in that field.
    And alias-to-pi-model mappings are configured outside the tool invocation schema.

  @ACC-SA-07-02 @proposed
  Scenario: Resolve an explicit alias through configuration.
    Given the alias "sonnet" maps to the available pi model "test-provider/reviewer-model".
    And the selected definition specifies a different available model.
    When the parent launches the agent with "model" set to "sonnet".
    Then the child uses "test-provider/reviewer-model".
    And the tool result and inspector identify that resolved model.

  @ACC-SA-07-03 @proposed
  Scenario: Refuse an explicit alias with no mapping.
    Given the alias "fable" has no configured mapping.
    When the parent requests an agent with "model" set to "fable".
    Then the tool identifies the missing alias mapping.
    And no different model is selected as a fallback.
    And no child provider request occurs.

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
