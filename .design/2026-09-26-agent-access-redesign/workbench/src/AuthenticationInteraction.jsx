import React from "react";
import "./account-handoff.css";
import OfficialLoginHandoff from "./OfficialLoginHandoff.jsx";

// One presentation for declared browser/device authentication and documented
// program actions. The declaration selects the interaction, never the brand.
export default function AuthenticationInteraction({
  job,
  onPageChange,
  onComplete,
  onFailure,
  accountRoute,
}) {
  return (
    <OfficialLoginHandoff
      job={job}
      accountRoute={accountRoute}
      onPageChange={onPageChange}
      onComplete={onComplete}
      onFailure={onFailure}
    />
  );
}
