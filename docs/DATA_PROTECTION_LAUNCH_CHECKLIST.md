# Nzuko AI data-protection launch checklist

This working checklist supports, but does not replace, advice from a qualified UK data-protection professional.

## Must be completed by RohariGroup LTD before unrestricted launch

- [ ] Rotate every credential exposed in messages or screenshots: Stripe live secret, Stripe webhook secret, Telegram API hash, WAHA key, server passwords and any exposed SSH key.
- [ ] Complete the ICO data-protection fee self-assessment and register/pay unless exempt.
- [x] Add Rohari Group Ltd's registered-office address and company number to the privacy notice and terms.
- [ ] Maintain a Record of Processing Activities covering accounts, connected conversations, reports, billing, support, logs and marketing.
- [ ] Select and document Article 6 lawful bases for RohariGroup LTD's controller activities.
- [ ] Sign and publish a customer Data Processing Agreement containing Article 28 terms.
- [ ] Accept and retain copies of DPAs for OpenAI, Netlify, Supabase, Hetzner and other processors where applicable.
- [ ] Maintain a public subprocessor schedule and a process for notifying customers of changes.
- [ ] Map processing locations and document adequacy or the UK IDTA/Addendum and transfer-risk assessment where required.
- [ ] Complete and approve the DPIA before healthcare, special-category, vulnerable-person or systematic worker-monitoring use.
- [ ] Create procedures for access, correction, deletion, restriction, objection and portability requests.
- [ ] Create a breach-response plan, including assessment of the ICO's 72-hour notification requirement.
- [ ] Define retention for source messages, approved reports, actions, account data, billing data, support and security logs.
- [ ] Test account/workspace export and deletion, including the supplier and backup deletion process.
- [ ] Review WhatsApp, Telegram and WAHA terms and document the risk of using bridge/linked-device automation.

## Product controls implemented

- AI reconciliation is protected by both a deployment feature flag and per-workspace authorisation.
- AI reconciliation is off by default.
- Standard deterministic reports remain available while AI reconciliation is off.
- Common email addresses, telephone numbers, links and platform identifiers are removed before reconciliation.
- Only the latest 200 structured messages are considered, with field-level length limits.
- OpenAI requests use `store: false`.
- Reports remain drafts until human approval.
- Authorisation changes and the report engine used are written to the workspace audit log.
- Captured source-message retention is enforced server-side, with a 14-day default and a 90-day maximum.

## Initial market boundary

Launch first with property, facilities, field-service and ordinary administrative teams. Exclude clinical records, care decisions, safeguarding, children, criminal-offence data and employee disciplinary decisions until the relevant DPIA, lawful-basis analysis, special-category condition and contracts are approved.
