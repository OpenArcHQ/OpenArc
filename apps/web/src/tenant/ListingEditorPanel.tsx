import { useEffect, useMemo, useState } from "react";

import {
  CommerceListingKindSchema,
  type CommerceListingKind,
  type CommerceListingOwnerVersion,
  type CommerceMarketListingContent,
  type CommerceMarketProviderOption,
} from "@openarc/shared";

import {
  buildListingContent,
  formatFixedPriceFromAtomic,
  parseFixedPriceToAtomic,
} from "./listing-controller.js";

/**
 * Explicit create/version editor. An existing version is NEVER edited in place:
 * selecting a historical version only pre-fills a NEW-version form.
 *
 * All eleven content fields come from `CommerceMarketListingContentSchema`. No
 * fake digests are generated, no secrets or arbitrary URLs are accepted, and a
 * fixed price in TestnetUSDC is converted with `BigInt`/strings to exactly six
 * decimals (never `Number`). The endpoint path is owner-only metadata and is
 * never disclosed publicly.
 */

export interface ListingContentFormValues {
  readonly kind: CommerceListingKind;
  readonly title: string;
  readonly description: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly price: string;
  readonly receiptType: string;
  readonly receiptSchemaDigest: string;
  readonly deliveryFields: string;
  readonly endpointOrigin: string;
  readonly endpointPath: string;
  readonly termsRevision: string;
  readonly privacySummary: string;
  readonly availabilityStatus: "available" | "unavailable";
  readonly rateLimitPerMinute: string;
}

export function emptyListingContentForm(): ListingContentFormValues {
  return {
    kind: "api",
    title: "",
    description: "",
    inputSchemaDigest: "",
    outputSchemaDigest: "",
    price: "",
    receiptType: "",
    receiptSchemaDigest: "",
    deliveryFields: "",
    endpointOrigin: "",
    endpointPath: "",
    termsRevision: "",
    privacySummary: "",
    availabilityStatus: "unavailable",
    rateLimitPerMinute: "",
  };
}

export function formValuesFromContent(content: CommerceMarketListingContent): ListingContentFormValues {
  return {
    kind: content.kind,
    title: content.title,
    description: content.description,
    inputSchemaDigest: content.manifest.inputSchemaDigest,
    outputSchemaDigest: content.manifest.outputSchemaDigest,
    price: formatFixedPriceFromAtomic(content.price.amount.atomicAmount),
    receiptType: content.evidenceContract.receiptType,
    receiptSchemaDigest: content.evidenceContract.receiptSchemaDigest,
    deliveryFields: content.evidenceContract.deliveryFields.join(", "),
    endpointOrigin: content.endpointContract.origin,
    endpointPath: content.endpointContract.path,
    termsRevision: content.termsRevision,
    privacySummary: content.privacySummary,
    availabilityStatus: content.availability.status,
    rateLimitPerMinute: content.availability.rateLimitPerMinute ?? "",
  };
}

/** Converts read form values into the exact 11-field content contract. */
export function contentFromFormValues(values: ListingContentFormValues): CommerceMarketListingContent | null {
  const priceAtomic = parseFixedPriceToAtomic(values.price);
  if (priceAtomic === null) return null;
  const deliveryFields = values.deliveryFields
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  const rateLimitPerMinute = values.rateLimitPerMinute.trim();
  return buildListingContent({
    kind: values.kind,
    title: values.title,
    description: values.description,
    inputSchemaDigest: values.inputSchemaDigest,
    outputSchemaDigest: values.outputSchemaDigest,
    priceAtomic,
    receiptType: values.receiptType,
    receiptSchemaDigest: values.receiptSchemaDigest,
    deliveryFields,
    endpointOrigin: values.endpointOrigin,
    endpointPath: values.endpointPath,
    termsRevision: values.termsRevision,
    privacySummary: values.privacySummary,
    availabilityStatus: values.availabilityStatus,
    rateLimitPerMinute: rateLimitPerMinute.length === 0 ? null : rateLimitPerMinute,
  });
}

function field(
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
  options: { type?: string; hint?: string; required?: boolean; multiline?: boolean } = {},
) {
  return (
    <p className="tenant-listings__field" key={id}>
      <label htmlFor={id}>
        {label}
        {options.required === true ? <span aria-hidden="true"> *</span> : null}
      </label>
      {options.multiline === true ? (
        <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={3} />
      ) : (
        <input
          id={id}
          type={options.type ?? "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {options.hint === undefined ? null : <span className="tenant-listings__hint">{options.hint}</span>}
    </p>
  );
}

export function ListingContentForm(props: {
  readonly values: ListingContentFormValues;
  readonly onChange: (values: ListingContentFormValues) => void;
  readonly idPrefix: string;
}) {
  const { values, idPrefix } = props;
  const set = (key: keyof ListingContentFormValues) => (value: string) => {
    props.onChange({ ...values, [key]: value } as ListingContentFormValues);
  };
  return (
    <fieldset className="tenant-listings__fieldset">
      <legend>Listing content</legend>
      <p className="tenant-listings__field">
        <label htmlFor={`${idPrefix}-kind`}>Kind</label>
        <select
          id={`${idPrefix}-kind`}
          value={values.kind}
          onChange={(event) => props.onChange({ ...values, kind: event.target.value as CommerceListingKind })}
        >
          {CommerceListingKindSchema.options.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </p>
      {field(`${idPrefix}-title`, "Title", values.title, set("title"), { required: true })}
      {field(`${idPrefix}-description`, "Description", values.description, set("description"), {
        required: true,
        multiline: true,
      })}
      {field(`${idPrefix}-input-digest`, "Input schema digest", values.inputSchemaDigest, set("inputSchemaDigest"), {
        hint: "Exactly sha256:<64 lowercase hex>. No digest is generated for you.",
        required: true,
      })}
      {field(`${idPrefix}-output-digest`, "Output schema digest", values.outputSchemaDigest, set("outputSchemaDigest"), {
        hint: "Exactly sha256:<64 lowercase hex>.",
        required: true,
      })}
      {field(`${idPrefix}-price`, "Fixed price (TestnetUSDC)", values.price, set("price"), {
        hint: "Human decimal, at most 6 fractional digits. Converted exactly with BigInt.",
        required: true,
      })}
      {field(`${idPrefix}-receipt-type`, "Receipt type", values.receiptType, set("receiptType"), { required: true })}
      {field(`${idPrefix}-receipt-digest`, "Receipt schema digest", values.receiptSchemaDigest, set("receiptSchemaDigest"), {
        required: true,
      })}
      {field(`${idPrefix}-delivery`, "Delivery fields", values.deliveryFields, set("deliveryFields"), {
        hint: "Comma-separated lowercase identifiers, at least one.",
        required: true,
      })}
      {field(`${idPrefix}-origin`, "Endpoint origin", values.endpointOrigin, set("endpointOrigin"), {
        hint: "Canonical lowercase HTTPS origin. This origin becomes public.",
        required: true,
      })}
      {field(`${idPrefix}-path`, "Endpoint path", values.endpointPath, set("endpointPath"), {
        hint: "Owner-only metadata. The protected path is never disclosed publicly.",
        required: true,
      })}
      {field(`${idPrefix}-terms`, "Terms revision", values.termsRevision, set("termsRevision"), { required: true })}
      {field(`${idPrefix}-privacy`, "Privacy summary", values.privacySummary, set("privacySummary"), {
        required: true,
        multiline: true,
      })}
      <p className="tenant-listings__field">
        <label htmlFor={`${idPrefix}-availability`}>Availability</label>
        <select
          id={`${idPrefix}-availability`}
          value={values.availabilityStatus}
          onChange={(event) =>
            props.onChange({
              ...values,
              availabilityStatus: event.target.value === "available" ? "available" : "unavailable",
            })
          }
        >
          <option value="unavailable">unavailable</option>
          <option value="available">available</option>
        </select>
        <span className="tenant-listings__hint">
          Provider availability is a declared status, not a grant, quality or payment proof.
        </span>
      </p>
      {field(`${idPrefix}-rate`, "Rate limit per minute", values.rateLimitPerMinute, set("rateLimitPerMinute"), {
        hint: "Optional canonical decimal 1..1000000.",
      })}
      <p className="tenant-listings__field">
        <span className="tenant-listings__label">Payment lane</span>
        <span className="tenant-mono">unavailable</span>
      </p>
    </fieldset>
  );
}

export function ListingEditorPanel(props: {
  readonly mode: "create-draft" | "create-version";
  readonly providerOptions: readonly CommerceMarketProviderOption[];
  readonly providerOptionsStatus: "none" | "loading" | "ready" | "error";
  readonly selectedProviderId: string | null;
  readonly onSelectProvider: (providerId: string) => void;
  readonly prefill: CommerceMarketListingContent | null;
  readonly baseVersion: CommerceListingOwnerVersion | null;
  readonly canWrite: boolean;
  readonly onSubmitDraft: (providerId: string, content: CommerceMarketListingContent) => void;
  readonly onSubmitVersion: (content: CommerceMarketListingContent) => void;
  readonly onCancel: () => void;
  readonly onLoadMoreProviders: () => void;
  readonly hasNextProviders: boolean;
}) {
  const [values, setValues] = useState<ListingContentFormValues>(emptyListingContentForm);
  const [message, setMessage] = useState<string | null>(null);
  const prefill = props.prefill;

  useEffect(() => {
    setValues(prefill === null ? emptyListingContentForm() : formValuesFromContent(prefill));
    setMessage(null);
  }, [prefill]);

  const content = useMemo(() => contentFromFormValues(values), [values]);
  const activeProvider = props.providerOptions.find(
    (option) => option.providerId === props.selectedProviderId,
  );
  const providerReady =
    props.mode === "create-version" ||
    (props.selectedProviderId !== null && activeProvider?.status === "active");

  const submit = () => {
    if (content === null) {
      setMessage("Some fields are invalid. Fix the highlighted constraints and try again.");
      return;
    }
    if (props.mode === "create-draft") {
      if (props.selectedProviderId === null || activeProvider === undefined) {
        setMessage("Choose an active provider for the new draft.");
        return;
      }
      if (activeProvider.status !== "active") {
        setMessage("The selected provider is inactive; writes are disabled. An owner must activate it.");
        return;
      }
      props.onSubmitDraft(props.selectedProviderId, content);
      return;
    }
    props.onSubmitVersion(content);
  };

  return (
    <section className="tenant-listings__editor" aria-labelledby="listing-editor-title">
      <h2 className="tenant-title tenant-title--small" id="listing-editor-title">
        {props.mode === "create-draft" ? "Create first draft" : `Create new version from ${props.baseVersion?.version ?? "selected version"}`}
      </h2>
      <p className="tenant-status" role="status">
        {props.mode === "create-draft"
          ? "The first draft is created with a deterministic id derived from the mutation id. The detail page opens after the commit."
          : "The selected version is never edited in place. Your edits create a new immutable version."}
      </p>
      {props.mode === "create-draft" ? (
        <div className="tenant-listings__provider">
          <p className="tenant-listings__label" id="listing-provider-label">
            Provider
          </p>
          {props.providerOptionsStatus === "loading" ? (
            <p className="tenant-status" role="status">Loading providers…</p>
          ) : null}
          {props.providerOptionsStatus === "error" ? (
            <p className="tenant-status tenant-status--error" role="alert">
              Providers could not be loaded. You can continue only with an active provider.
            </p>
          ) : null}
          {props.providerOptionsStatus === "ready" && props.providerOptions.length === 0 ? (
            <p className="tenant-empty">
              No providers are available. An owner must create an active provider under the existing
              provider console first.
            </p>
          ) : null}
          {props.providerOptions.map((option) => {
            const inactive = option.status !== "active";
            return (
              <label className="tenant-listings__provider-option" key={option.providerId}>
                <input
                  type="radio"
                  name="listing-provider"
                  value={option.providerId}
                  checked={props.selectedProviderId === option.providerId}
                  disabled={inactive}
                  onChange={() => props.onSelectProvider(option.providerId)}
                />
                <span>
                  {option.displayName}{" "}
                  <span className="tenant-mono">{option.providerId}</span>{" "}
                  {inactive ? <span className="tenant-status--warning">inactive — writes disabled</span> : null}
                </span>
              </label>
            );
          })}
          {props.hasNextProviders ? (
            <button type="button" className="tenant-button" onClick={props.onLoadMoreProviders}>
              Next providers
            </button>
          ) : null}
        </div>
      ) : null}
      <ListingContentForm values={values} onChange={setValues} idPrefix={`${props.mode}-content`} />
      {message === null ? null : (
        <p className="tenant-status tenant-status--error" role="alert">
          {message}
        </p>
      )}
      <div className="tenant-actions">
        <button
          type="button"
          className="tenant-button tenant-button--primary"
          disabled={!props.canWrite || !providerReady}
          onClick={submit}
        >
          Review {props.mode === "create-draft" ? "draft" : "new version"}
        </button>
        <button type="button" className="tenant-button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * Publishing disclosure. Publishing makes title, description, provider name,
 * price, terms and privacy metadata public; the protected endpoint path does
 * not. A listing owner can never self-approve an origin review.
 */
export function ListingPublishDisclosure(props: {
  readonly version: CommerceListingOwnerVersion;
  readonly activeVersion: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly canWrite: boolean;
}) {
  return (
    <section className="tenant-listings__disclosure" aria-labelledby="listing-publish-title">
      <h3 className="tenant-title tenant-title--small" id="listing-publish-title">
        Publish version {props.version.version}
      </h3>
      <p className="tenant-status">
        Publishing makes the title, description, provider name, fixed price, terms revision and privacy
        summary public. The protected endpoint path is NOT disclosed. Publishing atomically pauses the
        prior active version (currently {props.activeVersion ?? "none"}). Origin review approval is a
        manual moderation step and is never self-service.
      </p>
      <p className="tenant-mono">
        expectedUpdatedAt {props.version.updatedAt} · expectedActiveVersion {props.activeVersion ?? "null"}
      </p>
      <div className="tenant-actions">
        <button
          type="button"
          className="tenant-button tenant-button--primary"
          disabled={!props.canWrite}
          onClick={props.onConfirm}
        >
          Confirm publish
        </button>
        <button type="button" className="tenant-button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

export function ListingLifecycleActions(props: {
  readonly version: CommerceListingOwnerVersion;
  readonly activeVersion: string | null;
  readonly canWrite: boolean;
  readonly onPublish: () => void;
  readonly onPause: () => void;
  readonly onRetire: () => void;
}) {
  const { version } = props;
  const publishable =
    (version.status === "draft" || version.status === "paused") &&
    version.originReviewState === "approved";
  return (
    <div className="tenant-actions tenant-listings__lifecycle">
      {publishable ? (
        <button
          type="button"
          className="tenant-button tenant-button--primary"
          disabled={!props.canWrite}
          onClick={props.onPublish}
        >
          Publish version {version.version}
        </button>
      ) : (
        <p className="tenant-status tenant-status--warning" role="status">
          Version {version.version} cannot be published: it must be an approved draft or paused version.
        </p>
      )}
      {version.status === "active" ? (
        <button type="button" className="tenant-button" disabled={!props.canWrite} onClick={props.onPause}>
          Pause active version {version.version}
        </button>
      ) : null}
      {version.status === "active" || version.status === "paused" ? (
        <button type="button" className="tenant-button" disabled={!props.canWrite} onClick={props.onRetire}>
          Retire version {version.version}
        </button>
      ) : null}
      {version.status === "retired" ? (
        <p className="tenant-status">Version {version.version} is retired and terminal.</p>
      ) : null}
    </div>
  );
}
