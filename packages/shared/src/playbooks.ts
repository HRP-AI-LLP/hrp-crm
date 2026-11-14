/**
 * Sales and growth playbooks per industry solution: the discovery questions agents bring to a
 * first meeting, and the repeat-business plays they look for after an order is delivered.
 */
export interface GrowthPlay {
  key: string;
  title: string;
  /** days after the last completed installation / delivered order before suggesting it */
  afterDays: number;
  pitch: string;
}

export interface Playbook {
  discovery: string[];
  plays: GrowthPlay[];
}

const GENERIC: Playbook = {
  discovery: [
    'What prompted you to look for this now?',
    'Who else is involved in the decision, and how will you decide?',
    'What budget range have you set aside?',
    'By when do you need this done, and what drives that date?',
    'Who else are you talking to, and what do you like about them?',
  ],
  plays: [
    { key: 'referral', title: 'Ask for a referral', afterDays: 14, pitch: 'Happy customers are the best source of new work: ask who else they know who is planning something similar.' },
    { key: 'reengage', title: 'Re-engage a past customer', afterDays: 300, pitch: 'It has been a while since their last order: check in with something new or seasonal.' },
  ],
};

export const PLAYBOOKS: Record<string, Playbook> = {
  generic: GENERIC,
  interiors: {
    discovery: [
      'Which rooms are in scope, and is the property new or a renovation?',
      'When do you get possession, and when do you want to move in?',
      'What style do you like? Any reference photos?',
      'What budget band are you comfortable with for the full scope?',
      'Is anyone else (architect, family) part of the decision?',
      'Have you seen designs from other studios? What stood out?',
    ],
    plays: [
      { key: 'referral', title: 'Ask for a referral', afterDays: 14, pitch: 'Neighbours in the same society often furnish at the same time: ask for introductions.' },
      { key: 'next_room', title: 'Next room or furnishing refresh', afterDays: 120, pitch: 'Offer the rooms left out of the first scope, soft furnishings or a décor refresh.' },
      { key: 'maintenance', title: 'Annual care visit', afterDays: 330, pitch: 'A yearly check of hinges, channels and finishes keeps the warranty experience strong.' },
    ],
  },
  modular: {
    discovery: [
      'What layout is the kitchen today (L, U, parallel, island)?',
      'Which finishes do you prefer: laminate, acrylic, PU, veneer?',
      'Which appliances do you want built in?',
      'How many people cook, and how often?',
      'What budget have you planned, and by when should it be installed?',
    ],
    plays: [
      { key: 'referral', title: 'Ask for a referral', afterDays: 14, pitch: 'Ask for introductions to friends and neighbours planning a kitchen.' },
      { key: 'wardrobes', title: 'Wardrobes and storage', afterDays: 60, pitch: 'Customers who loved their kitchen often do wardrobes next: offer a design visit.' },
      { key: 'appliances', title: 'Appliance and accessory add-ons', afterDays: 90, pitch: 'Tall units, organisers, a chimney or hob upgrade.' },
      { key: 'service', title: 'Annual kitchen service', afterDays: 330, pitch: 'Hinge and channel adjustment, deep clean and seal check.' },
    ],
  },
  solar: {
    discovery: [
      'What is your average monthly electricity bill, summer and winter?',
      'What is the sanctioned load, and is net metering already applied for?',
      'How much shade-free roof area is available?',
      'Do you want to claim the PM Surya Ghar subsidy?',
      'Are you looking at on-grid, hybrid or off-grid with batteries?',
    ],
    plays: [
      { key: 'amc', title: 'Cleaning and maintenance contract (AMC)', afterDays: 30, pitch: 'Dusty panels lose output: offer a yearly cleaning and inspection contract.' },
      { key: 'battery', title: 'Battery backup add-on', afterDays: 90, pitch: 'Offer a hybrid upgrade for backup during power cuts.' },
      { key: 'referral', title: 'Ask for a referral', afterDays: 45, pitch: 'Share their first savings and ask for neighbours who might want the same.' },
      { key: 'expansion', title: 'Capacity expansion', afterDays: 365, pitch: 'New appliances or an EV? Offer more panels.' },
    ],
  },
  fabrication: {
    discovery: [
      'What are you fabricating, and to which drawing or specification?',
      'Which material and finish (MS, SS, aluminium; powder coat, galvanising)?',
      'Where is the site, and who handles installation?',
      'What quantity, and by when is it needed?',
      'Who approves drawings and payments?',
    ],
    plays: [
      { key: 'maintenance', title: 'Painting and maintenance contract', afterDays: 300, pitch: 'Offer periodic repainting, rust treatment and inspection.' },
      { key: 'referral', title: 'Ask for a referral', afterDays: 21, pitch: 'Ask the site engineer or architect for their next project.' },
      { key: 'reengage', title: 'Next project check-in', afterDays: 180, pitch: 'Contractors usually have a pipeline: ask what is coming up.' },
    ],
  },
  signage: {
    discovery: [
      'Where will the sign go, and what are the dimensions?',
      'Indoor or outdoor; lit or non-lit?',
      'Do you have brand guidelines and print-ready artwork?',
      'Is a municipal or landlord permission needed?',
      'How many outlets will need the same sign?',
    ],
    plays: [
      { key: 'rollout', title: 'Roll out to more outlets', afterDays: 30, pitch: 'Offer the same signage for their other branches at a volume price.' },
      { key: 'led_upgrade', title: 'LED upgrade', afterDays: 180, pitch: 'Offer an LED retrofit to cut power use and brighten the sign.' },
      { key: 'maintenance', title: 'Annual maintenance', afterDays: 330, pitch: 'Cleaning, light checks and repairs before festive season.' },
    ],
  },
};

/** The playbook for the first enabled solution module, else the generic one. */
export function playbookFor(enabledModules: string[]): Playbook & { key: string } {
  for (const k of enabledModules) if (PLAYBOOKS[k] && k !== 'generic') return { key: k, ...PLAYBOOKS[k]! };
  return { key: 'generic', ...GENERIC };
}
