# Nzuko AI DPIA working template

## Processing description

Nzuko AI imports authorised WhatsApp or Telegram group messages and voice-note transcripts for a selected period, produces a structured draft report, and requires human approval before the report becomes an operational record.

## Data flow

1. A workspace owner authenticates and selects an authorised group.
2. The owner chooses a limited reporting period.
3. Source material is held in the workspace store for the configured short retention period.
4. When optional AI reconciliation is enabled and authorised, minimised content is sent to OpenAI.
5. A draft is returned for human correction and approval.
6. Approved actions and audit metadata are retained according to the applicable schedule.

## People and data

Record the people affected, data categories, expected volumes, countries, processors, special-category data, vulnerable people and whether workers are monitored.

## Purpose, necessity and proportionality

Document why conversation reporting is needed, why less intrusive alternatives are insufficient, the lawful basis, any Article 9 condition, how participants are informed, and how their rights are supported.

## Key risks and controls

| Risk | Initial control |
| --- | --- |
| Participants are unaware of processing | Customer notice, group authorisation record and just-in-time workspace notice |
| Excessive source material | Selected date range, message limits, field limits and 14-day default retention |
| Identifiers disclosed to AI supplier | Redaction of common identifiers before reconciliation |
| Incorrect decision/action extraction | Conservative reconciliation, confidence rules and mandatory human approval |
| Staff are unfairly monitored | No disciplinary use; customer necessity/proportionality assessment and worker notice |
| Health or vulnerable-person data is processed | Initial prohibition; dedicated DPIA and written approval before use |
| International-transfer risk | Processor mapping, DPA, transfer mechanism and transfer-risk assessment |
| Unauthorised workspace access | Authentication, scoped workspaces, connector authorisation and audit logs |
| Credential compromise | Secret storage, rotation procedure, least privilege and incident response |

## Residual-risk decision

Name the accountable approver, date, remaining risks and whether processing is approved, rejected, or requires prior consultation with the ICO. Do not launch the high-risk use case until this section is completed.
