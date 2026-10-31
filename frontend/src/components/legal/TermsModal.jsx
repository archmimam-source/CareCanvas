import React, { useState } from "react";
import { api } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ShieldAlert, ScrollText, X as XIcon } from "lucide-react";

/**
 * Beta Terms of Service gate — displayed on first sign-in (or when the
 * current Terms version supersedes what the user last accepted). Adapted
 * from the reference template with extra healthcare-domain scrutiny:
 * the Service is a PROTOTYPE that generates conceptual healthcare
 * configurations against public standards (NHS HBN, ASHRAE 170, WHO WASH
 * FIT), and its outputs MUST NOT be treated as clinical, engineering,
 * or regulatory advice.
 */
export const TERMS_VERSION = "v2026-02-09"; // bump when Terms are updated
export const TERMS_DATE    = "February 9, 2026";

export default function TermsModal({ user, onAccepted, onDecline }) {
  const [expanded, setExpanded] = useState(false);
  const [checked, setChecked]   = useState(false);
  const [busy, setBusy]         = useState(false);

  const accept = async () => {
    if (!checked) return;
    setBusy(true);
    try {
      // Persist to the user record so the gate stays passed across
      // devices for signed-in users, and to localStorage for guests.
      try {
        await api.patch("/auth/me", { bio: user?.bio /* no-op patch to warm session */ });
      } catch {}
      try {
        await api.post("/auth/terms/accept", { version: TERMS_VERSION });
      } catch {}
      try {
        localStorage.setItem("his:tos_accepted_version", TERMS_VERSION);
        localStorage.setItem("his:tos_accepted_at", new Date().toISOString());
      } catch {}
      onAccepted && onAccepted();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-sm flex items-center justify-center px-4"
         data-testid="tos-modal">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl max-h-[88vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/5">
          <div className="flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-slate-700" />
            <div className="font-display text-lg font-semibold tracking-tight">
              HealthcareCanvas Beta Terms of Service
            </div>
          </div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
            {TERMS_VERSION} · {TERMS_DATE}
          </div>
        </div>

        <div className="px-6 py-4 border-b border-black/5 bg-rose-50/70">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-700 mt-0.5 flex-shrink-0" />
            <div className="text-[13px] leading-relaxed text-rose-900">
              <strong>This is a prototype application.</strong> Because HealthcareCanvas
              operates in a <strong>healthcare context</strong>, its outputs
              carry <strong>additional scrutiny obligations</strong>. The
              validation engine, layout suggestions, and derogation reports
              are <em>advisory</em>. Nothing produced by HealthcareCanvas is a substitute
              for a licensed architect, IPC clinician, engineer, or regulator
              signing off on a real-world clinical space. Rooms designed
              here must be independently reviewed against your jurisdiction's
              current NHS HBN / ASHRAE / WHO / local codes before any
              patient-facing implementation.
            </div>
          </div>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 text-[13px] leading-relaxed text-slate-800 space-y-4"
             data-testid="tos-body">
          <p className="text-slate-600">
            Please read these Beta Terms of Service ("Terms") carefully before
            accessing or using HealthcareCanvas — the HealthcareCanvas Co-Design
            platform, calculation engine, and associated software integrations
            (collectively, the "Service"), provided and operated by the
            platform creators and developers ("Service Provider", "we", "us",
            or "our").
          </p>
          <p>
            By accessing, testing, or using the Service, you ("User" or "you")
            agree to be legally bound by these Terms. If you do not agree, you
            must immediately cease all access to and use of the Service.
          </p>

          {expanded ? (
            <div className="space-y-4">
              <Section n="1" title="Beta Stage & Healthcare Prototype">
                You acknowledge and agree that the Service is currently in a
                public or private Beta testing phase, positioned as a
                <em> conceptual prototype for healthcare design workflows</em>.
                Because it operates in a clinical / infection-prevention
                context, the following restrictions apply <strong>in addition</strong>
                to standard beta terms:
                <ul className="list-disc pl-6 mt-2 space-y-1">
                  <li>Outputs are <strong>not diagnostic, clinical, or medical
                      advice</strong> and MUST NOT be used to make patient-care
                      decisions.</li>
                  <li>Room layouts, flow paths and compliance flags are
                      <strong> conceptual</strong>; final clinical suitability must be
                      verified with your Infection Prevention & Control lead,
                      the responsible authority-having-jurisdiction, and the
                      current published editions of NHS HBN 00-09, HBN 00-03,
                      HBN 04-01, HBN 11-01, ASHRAE 170, WHO WASH FIT, and any
                      applicable local codes.</li>
                  <li>Data volatility: we may modify, reset, wipe or suspend
                      user accounts, project models, and calculation histories
                      without notice. Do not rely on the Service as a permanent
                      repository for patient-associated project data.</li>
                </ul>
              </Section>
              <Section n="2" title="Intellectual Property & Ownership">
                The Service — including its calculation engines, spatial
                evaluation logic, rule ingestion pipelines, UX/UI layouts,
                text, graphics, and software integrations (Revit / IFC / A*
                pathfinding / AI renders) — is the exclusive property of the
                Service Provider and is protected by copyright, trade secret,
                and intellectual property laws. Subject to your compliance,
                you are granted a limited, non-exclusive, non-transferable,
                revocable license to access and use the Service strictly for
                evaluation, testing, and design exploration.
              </Section>
              <Section n="3" title="Strict Restrictions on Use">
                You agree NOT to, directly or indirectly:
                decompile, reverse-engineer, or attempt to derive the
                source, formulas, spatial deduction logic, environmental
                multipliers, or underlying architecture of the Service;
                clone workflows or calculation sequences to build a
                competing product; scrape or automate access; commercially
                resell or sublicense; or bypass security or rate limits.
              </Section>
              <Section n="4" title="Patient Data & Confidentiality">
                HealthcareCanvas is not currently qualified as a PHI/PII repository. Do
                NOT upload any identifiable patient information, PHI, PII,
                or other regulated healthcare data (HIPAA, GDPR-health,
                UK Data Protection, PIPEDA, etc.) into rooms, notes, or
                attachments. Unreleased features, backend methodologies,
                and future roadmap interfaces are Confidential Information;
                do not publish screenshots, recordings, or workflow
                documentation externally without written consent.
              </Section>
              <Section n="5" title="Feedback">
                By submitting bug reports, workflow suggestions or UI
                feedback, you grant us a perpetual, irrevocable,
                royalty-free, worldwide license to use, modify, incorporate
                and commercialize such feedback into the Service.
              </Section>
              <Section n="6" title="Professional Disclaimer (No Reliance)">
                The Service provides spatial, environmental, and resource
                calculation models for conceptual design only. You remain
                solely responsible for validating all measurements, IPC
                zoning, MEP, structural calculations, building code
                compliances, and localized environmental / clinical
                assessments through certified professional engineers,
                registered architects, and accredited clinicians before
                incorporating outputs into actual construction, procurement,
                bidding, or regulatory submissions.
              </Section>
              <Section n="7" title="Disclaimer of Warranties">
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE IS
                PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF
                ANY KIND, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY,
                FITNESS FOR A PARTICULAR PURPOSE, ACCURACY OF CALCULATION
                OUTPUTS, CLINICAL SUITABILITY, AND NON-INFRINGEMENT.
              </Section>
              <Section n="8" title="Limitation of Liability">
                IN NO EVENT SHALL THE SERVICE PROVIDER BE LIABLE FOR ANY
                INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
                DAMAGES — INCLUDING PATIENT-CARE OUTCOMES, CLINICAL
                INFECTION EVENTS, BID DELAYS, OR CONSTRUCTION-COST OVERRUNS
                — ARISING FROM YOUR USE OR INABILITY TO USE THE SERVICE.
                Aggregate liability shall not exceed the amount, if any,
                paid by you in the preceding twelve months.
              </Section>
              <Section n="9" title="Suspension & Termination">
                We may suspend or terminate your access at any time,
                immediately, for breach of these Terms.
              </Section>
              <Section n="10" title="Governing Law">
                These Terms are governed by the laws of the Province of
                British Columbia and the federal laws of Canada applicable
                therein. Exclusive jurisdiction and venue lies with the
                courts located in Vancouver, British Columbia.
              </Section>
              <Section n="11" title="General">
                Severability and Entire-Agreement clauses apply. We reserve
                the right to update these Terms; continued use following an
                update constitutes acceptance of the revised Terms.
              </Section>
              <button onClick={() => setExpanded(false)}
                      className="text-[11px] font-mono uppercase tracking-widest text-slate-500 hover:text-slate-900"
                      data-testid="tos-collapse">
                Hide the full Terms
              </button>
            </div>
          ) : (
            <button onClick={() => setExpanded(true)}
                    data-testid="tos-expand"
                    className="text-[11px] font-mono uppercase tracking-widest text-[#0071E3] hover:text-[#0077ED]">
              Read the full Beta Terms of Service →
            </button>
          )}
        </div>

        <div className="px-6 py-4 border-t border-black/5 bg-slate-50/60">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox checked={checked} onCheckedChange={(v) => setChecked(!!v)}
                      data-testid="tos-checkbox" className="mt-0.5" />
            <div className="text-[13px] text-slate-800 leading-snug">
              I have read and agree to the Beta Terms of Service
              (<span className="font-mono">{TERMS_VERSION}</span> · {TERMS_DATE}),
              I acknowledge HealthcareCanvas is a <strong>prototype</strong> and its
              outputs are <strong>not clinical / medical / regulatory advice</strong>.
            </div>
          </label>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onDecline}
                    data-testid="tos-decline"
                    className="h-9 rounded-full">
              I don't agree — sign me out
            </Button>
            <Button size="sm" onClick={accept} disabled={!checked || busy}
                    data-testid="tos-accept"
                    className="h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white px-5">
              {busy ? "Saving…" : "Accept & continue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ n, title, children }) {
  return (
    <div>
      <div className="font-display text-[13px] font-semibold tracking-tight mb-1">
        {n}. {title}
      </div>
      <div className="text-slate-700 text-[12.5px] leading-relaxed">{children}</div>
    </div>
  );
}
