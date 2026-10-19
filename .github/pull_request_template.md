Issue: #<!-- the issue number, or "none" for a task without one. Never a closing keyword (Closes, Fixes, Resolves): the issue is closed after the deployed check, not at the merge. -->

## Change

<!-- Owner-approved goal and boundaries. Requirements and implementation share this PR. -->

## Design

<!-- Figma node links / saved reference, or "No visual change". -->

## Acceptance

- [ ] <!-- Observable result -->

## Version

<!-- Next VERSION + CHANGELOG entry, or unchanged with the reason; "versioning off" when `delivery.versioning` is false. -->

## Recovery

<!-- Last verified deployment: main SHA, the main workflow's run id, and what `delivery.rollback` needs (record before merge); "no deployment" when `delivery.deploy` is false.
     Previous version serves on the resulting schema/data/config during the rollout, and after a rollback? Evidence or forward-fix plan.
     Never claim a rollback reverses database migrations. -->

## Verification

<!-- Final head SHA; Tester/Reviewer results; the PR's checks for that SHA; outside review notes and answers, or why it did not run; material limitations. -->

## Delivery

<!-- Coordinator fills after merge: merge SHA, main workflow run, deploy/smoke,
     changed-behaviour check, tag if version changed, or recovery result. -->
