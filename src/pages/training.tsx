import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { TrainingLayout } from "./layout";

type TrainingHomeProps = { resource: string };

type TrainingConsentProps = { details: ConsentDescription; handle: string };

export function TrainingHomePage({ resource }: TrainingHomeProps) {
  return (
    <TrainingLayout title="Connect your Garmin training">
      <h1>
        Send your workouts
        <br />
        to Garmin.
      </h1>
      <p>
        Connect an MCP-compatible assistant to create workouts, edit or delete them, and manage your
        Garmin training calendar. Sync Garmin Connect to send workouts to your compatible watch.
      </p>
      <div class="notice">
        <strong>Training MCP server URL</strong>
        <br />
        <code>{resource}</code>
      </div>
      <ol>
        <li>Add this server URL to your assistant and choose OAuth authentication.</li>
        <li>Review the assistant’s permissions, then continue to Garmin.</li>
        <li>Sign in to Garmin and allow Workout Import access.</li>
      </ol>
      <p>
        Workout sending uses the Garmin Business Training API. The service operator must have an
        approved Garmin developer application. Your Garmin Personal API key does not enable workout
        sending.
      </p>
      <p>
        <a href="/training/privacy">Storage and revocation</a>
      </p>
    </TrainingLayout>
  );
}

export function TrainingPrivacyDetails() {
  return (
    <>
      <p>
        The server stores OAuth clients, consent transactions and authorization grants in Cloudflare
        KV. Garmin access and refresh tokens are encrypted by the OAuth provider library inside each
        grant. MCP tools never return these credentials.
      </p>
      <p>
        Your assistant can create, read, update and delete workouts and their calendar entries.
        Workout responses are handled for the current request; the server does not store workout
        history.
      </p>
      <h2>How your workout data is used</h2>
      <p>
        This integration transfers workout instructions and calendar entries between Garmin Connect
        and the MCP client you choose. It does not sell your data or send it to advertisers. Garmin
        processes the workouts in your Garmin account. Cloudflare hosts this server and processes
        requests and encrypted authorization records on the operator’s behalf.
      </p>
      <h2>AI transparency and your consent</h2>
      <p>
        Your selected MCP client receives workout tool inputs and results. If that client uses an AI
        service, its provider also processes the data according to that client’s privacy policy and
        settings. The consent screen identifies the requesting client and return destination before
        you connect. Connect only a client you trust and whose settings prohibit using Garmin data
        or derived data to train, evaluate or improve AI models. This server does not train models.
      </p>
      <p>
        Continuing from the consent screen gives that client permission to process your workout data
        for the operations you request. You can withdraw permission at any time by revoking the MCP
        grant and removing the app in Garmin Connect’s Connected Apps. Removing access does not
        delete data already retained by your client; use that client’s controls to delete it.
      </p>
      <h2>Access, correction, export and deletion</h2>
      <p>
        Read workouts and calendar entries with the client’s read tools; save their JSON results to
        export them. Correct or delete workouts and calendar entries through the update and delete
        tools or Garmin Connect. Revoking the MCP refresh token deletes the local authorization
        grant. The server keeps no workout history; your selected client may retain conversations
        under its own policy. Credentials and workout payloads are excluded from application logs.
      </p>
      <p>
        MCP access tokens last at most one hour and expire before the Garmin access token. Refresh
        access ends within 30 days of an exchange and never lasts beyond the Garmin refresh token’s
        expiry.
      </p>
      <p>
        Remove this service from Garmin Connect’s Connected Apps to revoke the Garmin authorization.
        Revoking a local MCP token or grant only removes your assistant’s local access; it does not
        disconnect the app at Garmin.
      </p>
      <p>
        <a href="/training">Training setup</a>
      </p>
    </>
  );
}

export function TrainingPrivacyPage() {
  return (
    <TrainingLayout title="Storage and revocation">
      <h1>You control training access.</h1>
      <TrainingPrivacyDetails />
    </TrainingLayout>
  );
}

export function TrainingConsentPage({ details, handle }: TrainingConsentProps) {
  return (
    <TrainingLayout title="Authorize workout sending">
      <h1>Connect {details.clientName}.</h1>
      <p>
        {details.clientDomain ? (
          <>
            Published by <strong>{details.clientDomain}</strong>.
          </>
        ) : (
          "This client’s name is self-reported."
        )}{" "}
        Access will return to <strong>{details.redirectHost}</strong>.
      </p>
      {details.redirectIsLoopback && (
        <p class="notice">
          This sends access to an app on your computer. Continue only if you started this
          connection.
        </p>
      )}
      <p>
        Allow this assistant to create, read, update and delete workouts and their calendar entries.
        Changes affect your Garmin Connect account. Sync Garmin Connect to send workouts to your
        compatible watch. You will choose your Garmin account and approve Workout Import permission
        on Garmin’s next screen.
      </p>
      <p>
        By choosing Continue to Garmin, you consent to {details.clientName} receiving and processing
        workout inputs and results for your requested operations, including through its AI provider
        if it uses one. Use a client whose settings prohibit training, evaluating or improving AI
        models with Garmin data. You can withdraw access at any time; see the privacy details below.
      </p>
      <form method="post" action="/training/authorize">
        <input type="hidden" name="handle" value={handle} />
        <p>
          <strong>Requested permissions</strong>
        </p>
        <ul>
          {details.scope.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
        <p>
          <button name="decision" value="approve">
            Continue to Garmin
          </button>
          <button class="secondary" name="decision" value="deny">
            Deny
          </button>
        </p>
      </form>
      <p>
        <a href="/training/privacy">Storage and revocation</a>
      </p>
    </TrainingLayout>
  );
}

export function TrainingErrorPage() {
  return (
    <TrainingLayout title="Connection unsuccessful">
      <h1>Connection unsuccessful.</h1>
      <p>This connection could not be completed. Start again from your assistant.</p>
    </TrainingLayout>
  );
}
