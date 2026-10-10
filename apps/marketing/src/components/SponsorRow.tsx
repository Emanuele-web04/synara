// a list, not tiles: an earlier chip/card grid made a short list of names heavy — tier recognition is carried by order and the logo swap, not bigger names

import Image from "next/image";
import type { Sponsor } from "@/data/sponsors";
import { sponsorLink, sponsorMetaLabel } from "@/lib/sponsors";

export function SponsorRow({ sponsor }: { sponsor: Sponsor }) {
  const meta = sponsorMetaLabel(sponsor);

  return (
    <a
      href={sponsorLink(sponsor)}
      target="_blank"
      rel="noopener noreferrer"
      // the negative inset lets the hover tint bleed past the text column so the row reads as a list item, not a re-introduced card
      className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--mock-row)]"
    >
      {sponsor.logoUrl ? (
        // the $149+ tiers are sold on logo placement — a sponsor who sent a logo gets it in place of the avatar, same row, same height
        <Image
          src={sponsor.logoUrl}
          alt={`${sponsor.name} logo`}
          width={132}
          height={36}
          className="h-9 w-auto max-w-[132px] shrink-0 object-contain object-left"
        />
      ) : (
        <Image
          src={sponsor.avatarUrl}
          alt=""
          width={36}
          height={36}
          className="size-9 shrink-0 rounded-full object-cover ring-1 ring-[var(--divide)]"
        />
      )}

      <span className="min-w-0">
        <span className="block truncate text-[14px] leading-[1.35] font-medium text-[var(--text-primary)]">
          {sponsor.name}
        </span>
        {meta ? (
          <span className="block truncate text-[12px] leading-[1.35] text-[var(--text-tertiary)]">
            {meta}
          </span>
        ) : null}
      </span>
    </a>
  );
}
