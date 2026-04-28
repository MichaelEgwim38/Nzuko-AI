export const mockGroups = [
  {
    id: 'group-family-committee',
    name: 'Family Committee',
    memberCount: 42,
    consentStatus: 'pending',
  },
];

export const sampleChat = `Ada: We agreed to keep the meeting every evening at 8pm.
Tunde: I will draft the contribution list before Friday.
Mariam: Can we stop changing the venue every week?
Voice note - Chidi: Late payments should be recorded, but no penalty is final yet.
Ada: Decision: Yusuf will collect receipts and share screenshots on Saturdays.`;

export const sampleVoiceNotes = `Voice note from Chidi: The group discussed late payments. Most people supported reminders first before penalties. No final penalty was approved.
Voice note from Yusuf: I can collect the receipts every Saturday and post the totals.`;

export async function postApprovedRecap({ groupName, text }) {
  return {
    ok: true,
    provider: 'mock',
    groupName,
    postedAt: new Date().toISOString(),
    text,
  };
}
