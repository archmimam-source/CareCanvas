import React from "react";

/**
 * Wordmark. Product name is **HealthcareCanvas**; **Perkins&Will** and **HIS**
 * (Healthcare Infection Society) are credited as the two partner
 * organisations behind the pilot. Rendered inline so it fits inside a
 * horizontal top bar:
 *
 *   HealthcareCanvas · Perkins&Will × HIS
 */
export function Wordmark({ className = "", size = "base", subtle = false, solid = false }) {
  const scale =
    size === "sm" ? "text-sm"     :
    size === "lg" ? "text-2xl"    :
    size === "xl" ? "text-3xl"    :
                    "text-lg";
  const partnerOpacity = solid ? "opacity-70" : "opacity-55";
  const dot            = solid ? "mx-2 opacity-60" : "opacity-40 mx-2";
  return (
    <span className={`font-semibold tracking-tight ${scale} ${subtle ? "opacity-90" : ""} ${className}`}>
      HealthcareCanvas
      <span className={dot}>·</span>
      <span className={partnerOpacity}>
        Perkins<span className="opacity-80">&amp;</span>Will
        <span className="mx-1.5 opacity-60">×</span>
        HIS
      </span>
    </span>
  );
}

// Back-compat: existing imports of Logo / LogoTile keep working but render the wordmark.
export const Logo = Wordmark;
export const LogoTile = Wordmark;
export default Wordmark;
