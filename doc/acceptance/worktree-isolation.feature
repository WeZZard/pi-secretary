@subagents @draft @SA-06
Feature: Isolate child workspaces and retain their changes safely
  As a user,
  I want a child to work in an owned separate workspace when isolation is requested,
  so that its changes can be inspected without silently altering my checkout.

  Workspace lifecycle scenarios in this file cover Git worktrees. Directory-snapshot
  allocation and shared-directory defaults are covered by the real-provider E2E matrix
  described in docs/testing/subagent-e2e.md.

  @ACC-SA-06-01 @confirmed
  Scenario: Launch a child in a separate worktree.
    Given the parent is working in a valid Git repository.
    When an eligible "Agent" launch requests "isolation" set to "worktree".
    Then the child operates in a separate Git worktree.
    And the launch information identifies the worktree path, branch, and base commit.
    And the interface does not describe the worktree as a security sandbox.

  @ACC-SA-06-02 @proposed
  Scenario: Exclude uncommitted parent changes without modifying them.
    Given the parent checkout contains staged, unstaged, and untracked changes.
    When a child is launched in a worktree.
    Then the host does not copy those uncommitted changes into the child's checkout.
    And the host does not stash, commit, reset, or clean the parent checkout.
    And the result explains that uncommitted parent changes are excluded.

  @ACC-SA-06-03 @proposed @concurrency
  Scenario: Use the base commit captured when the launch was accepted.
    Given a worktree launch is accepted while the parent's HEAD is commit A.
    And the launch remains queued.
    When the parent moves HEAD to commit B before worktree allocation.
    And the queued launch is admitted.
    Then the child worktree uses commit A as its base.
    And the reported base commit agrees with the allocated checkout.

  @ACC-SA-06-04 @proposed
  Scenario Outline: Retain evidence rather than automatically committing or deleting it.
    Given a child finishes in its owned worktree with <changes>.
    When the run's final outcome is recorded.
    Then the worktree and its branch remain available for inspection.
    And the host does not create an automatic commit or merge.
    When cleanup is requested for that worktree.
    Then cleanup is refused with an explanation that changes require review.

    Examples:
      | changes                           |
      | unstaged tracked modifications    |
      | staged modifications              |
      | untracked files                   |
      | ignored files                     |
      | changed submodule state           |
      | commits beyond its base commit    |

  @ACC-SA-06-05 @proposed
  Scenario: Remove an unchanged idle Git worktree after confirmation.
    Given an idle agent has an unchanged owned worktree whose branch still points to its base commit.
    When the user requests cleanup and confirms the identified worktree.
    Then the verified worktree is removed.
    And the agent's transcript and outcome remain available.
    And the interface explains that the agent can no longer resume from that worktree.

  @ACC-SA-06-06 @proposed @concurrency
  Scenario: Reject stale cleanup after an agent resumes.
    Given the user opened cleanup confirmation for an idle agent with a Git worktree.
    And the agent resumes before confirmation is submitted.
    When the user confirms the earlier cleanup request.
    Then the active agent's worktree is not removed.
    And the user is told that the cleanup target is no longer eligible.

  @ACC-SA-06-07 @proposed @concurrency
  Scenario: Prevent resumption while cleanup is reserved.
    Given confirmed cleanup has reserved an idle agent's owned Git worktree.
    And removal has not yet finished.
    When another caller sends a message that would resume that agent.
    Then resumption is rejected with a cleanup-in-progress explanation.
    And no child execution starts in the worktree being removed.

  @ACC-SA-06-08 @proposed @recovery
  Scenario: Refuse resumption after uncertain cleanup.
    Given cleanup was interrupted after removal began.
    And the remaining worktree state cannot be verified.
    When the parent session is restored.
    Then the inspector reports that manual worktree recovery is required.
    And the agent cannot resume until the uncertainty is resolved.
    And execution does not fall back to the parent checkout.

  @ACC-SA-06-09 @proposed
  Scenario: Refuse cleanup of a foreign worktree.
    Given a worktree path or branch resembles a Secretary-generated name.
    But its ownership cannot be verified for the selected agent.
    When cleanup is requested.
    Then the worktree is not removed.
    And the response explains that ownership could not be verified.
