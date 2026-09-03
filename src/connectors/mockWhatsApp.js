export const mockGroups = [
  {
    id: 'group-demo-community',
    name: 'Demo Community Group',
    memberCount: 42,
    consentStatus: 'pending',
  },
];

export const sampleScenarios = {
  'healthcare-operations': {
    groupName: 'Meadow Care Operations',
    chatText: `Amara: The evening rota is one person short from 6pm.
Amara: I suggested calling the agency, but no booking was made.
Daniel: I can cover the evening shift from 6pm.
Manager: We agreed Daniel will cover, so agency cover is no longer required.
Amara: I will update and circulate the rota before 4pm.
Manager: Can reception confirm Daniel's building access before 5pm?`,
    voiceNotes: `Voice note from Priya: The morning medication audit is complete. This is an administrative handover only; no patient details are included.`,
  },
  'property-facilities': {
    groupName: 'Oak House Facilities',
    chatText: `Resident services: The boiler at Oak House is losing pressure again. A leak is suspected but not confirmed.
James: I will inspect the boiler tomorrow at 9am and report the confirmed cause by 11am.
Facilities manager: We agreed the boiler must remain in service until James completes the safety inspection.
Concierge: Access through Flat 3 is still awaiting confirmation.
Facilities manager: Can Leila confirm access with the tenant before 5pm today?`,
    voiceNotes: `Voice note from James: I checked the plant-room floor. It is dry, so the cause remains unconfirmed until tomorrow's inspection.`,
  },
  'field-service': {
    groupName: 'Northline Field Service',
    chatText: `Dispatch: Unit 14 was marked complete at noon.
Customer desk: The alarm returned during the customer's final test, so the job is not complete.
Leon: I will revisit Unit 14 today at 3pm and send the valve part number to Aisha before I leave.
Dispatch: We agreed to reopen job 14 and keep the customer informed.
Aisha: I will reserve the replacement valve once Leon confirms the part number.
Dispatch: Can the customer confirm site access for 3pm?`,
    voiceNotes: `Voice note from Leon: I am twenty minutes from the site and still on schedule for the 3pm visit.`,
  },
  'community-charity': {
    groupName: 'NeighbourLink Community',
    chatText: `Chair Ada: We agreed the volunteer meeting will remain at 8pm every Thursday.
Yusuf: I will collect donation receipts every Saturday and post the totals by 6pm.
Chair Ada: We agreed Yusuf will manage the Saturday receipt report.
Mariam: Members preferred payment reminders before penalties.
Secretary: No late-payment penalty was approved.
Mariam: Which community hall should become our permanent venue?`,
    voiceNotes: `Voice note from Chidi: Twelve families have registered for the food-bank collection. I will confirm the volunteer rota by Friday.`,
  },
  personal: {
    groupName: 'My weekly commitments',
    chatText: `Me: I originally planned to send the application on Monday, but the reference will not arrive until Wednesday.
Me: I will submit the completed application by Thursday at noon.
Me: I will follow up with Maya about the unpaid invoice on Friday at 10am.
Me: We agreed the dentist appointment remains booked for Tuesday at 2pm.
Me: Can I move the gym session to Saturday morning?`,
    voiceNotes: `Voice note from Me: I bought the train ticket for Tuesday and saved the receipt.`,
  },
};

export function sampleScenarioForMode(mode = '') {
  return sampleScenarios[mode] || sampleScenarios['community-charity'];
}

const defaultScenario = sampleScenarioForMode('community-charity');
export const sampleChat = defaultScenario.chatText;
export const sampleVoiceNotes = defaultScenario.voiceNotes;

export async function postApprovedRecap({ groupName, text }) {
  return {
    ok: true,
    provider: 'mock',
    groupName,
    postedAt: new Date().toISOString(),
    text,
  };
}
