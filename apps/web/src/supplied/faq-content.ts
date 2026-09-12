export interface SuppliedFaqItem {
  id: string;
  question: string;
  answer: string;
}

export interface SuppliedFaqGroup {
  id: string;
  title: string;
  items: readonly SuppliedFaqItem[];
}

/**
 * Dedicated public FAQ copy. These answers describe what is actually available
 * today (read-only evidence and a locally encrypted investigation workspace) and
 * label the commerce target as in-development. No payment, authentication or
 * mainnet capability is claimed.
 */
export const SUPPLIED_FAQ_GROUPS: readonly SuppliedFaqGroup[] = [
  {
    id: "today",
    title: "What is available today",
    items: [
      {
        id: "today-what",
        question: "What is OpenArc right now?",
        answer:
          "OpenArc is a read-only evidence and investigation workspace for agent activity on Arc Testnet. The live features are bounded public-source observations and a locally encrypted Vault for private records. It is not a live marketplace, payment executor or agent runner.",
      },
      {
        id: "today-data",
        question: "Where do my private records live?",
        answer:
          "Owner notes, labels, policies and evidence associations are encrypted in your browser's local Vault. Network reads require an explicit, recorded consent step and are limited to one bounded public identifier per request. The workspace never becomes a server data plane.",
      },
      {
        id: "today-execution",
        question: "Does OpenArc sign or move funds?",
        answer:
          "No. OpenArc does not hold keys, sign, broadcast or execute transactions, and it is not a payment authority. Wallet-based sign-in, when it is implemented for payment users, is deliberately separate from any spending permission.",
      },
    ],
  },
  {
    id: "commerce",
    title: "The commerce target",
    items: [
      {
        id: "commerce-status",
        question: "Is the commerce product already delivered?",
        answer:
          "No. Marketplace, budgets and purchase lanes are an in-development target, not a completion of the legacy M00–M09 investigation milestones. Those milestones delivered read-only evidence and local investigation features. The commerce direction follows the approved 0.3.1-draft specifications.",
      },
      {
        id: "commerce-network",
        question: "Is Mainnet enabled?",
        answer:
          "No. Arc Testnet (eip155:5042002) is the only configured network context. An announced launch date is not a verified public-mainnet configuration, so no mainnet capability is enabled or implied.",
      },
      {
        id: "commerce-screens",
        question: "Are the console screenshots live output?",
        answer:
          "No. Console and evidence screenshots are visibly labelled illustrative. They are design previews, not live agent answers, payment records or delivery evidence.",
      },
    ],
  },
  {
    id: "accounts",
    title: "Accounts, access and privacy",
    items: [
      {
        id: "accounts-guest",
        question: "Can I browse without an account?",
        answer:
          "Yes. Public browsing follows an account-free guest path that creates no server account record or credential. It does not grant protected team access, shared persistence or payment authority.",
      },
      {
        id: "accounts-passkey",
        question: "Do passkey accounts keep zero data?",
        answer:
          "No. Passkeys are the accepted access method for non-payment account users, but minimum credential and security records are required, such as a public verification key, a credential identifier and minimal account state. Passkey accounts are not anonymous and are not a zero-retention promise.",
      },
      {
        id: "accounts-wallet",
        question: "Does a connected wallet authorize payment?",
        answer:
          "No. Wallet sign-in, linking a payment wallet and granting an agent spending permission are separate actions; none silently implies another. A wallet login is not payment authority.",
      },
    ],
  },
];

export const SUPPLIED_FAQ_ITEMS: readonly SuppliedFaqItem[] = SUPPLIED_FAQ_GROUPS.flatMap(
  (group) => group.items,
);
