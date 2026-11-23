// FILE: SynbotMarkIcon.tsx
// Purpose: Monochrome profile of the Synara mascot for the app rail.
// Layer: SynBot UI primitive
// Exports: SynbotMarkIcon

export function SynbotMarkIcon({ className }: { readonly className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d={
          "M4.56 2.91 10.43 7.28 11.38 9.58Q12.32 9.25 13.32 9.35L14.07 6.90 19.39 2.92Q20.07 2.41 19.86 3.28L18.63 8.06 17.47 10.18Q19.00 9.12 21.16 9.02Q20.68 11.63 18.77 12.39L19.23 13.54 21.37 14.53Q23.04 15.33 22.41 17.15Q21.56 19.77 17.23 20.05L16.2 22H11.55L12.38 19.6Q9.86 19 8.35 17.42Q7.2 16.19 7.84 13.69Q4.42 13.2 2.72 9.85Q2.48 9.39 3 9.39Q5.57 9.4 8.22 11.19L6.45 8.41 4.01 3.48Q3.56 2.17 4.56 2.91Z" +
          "M12.21 12.85H15.76Q16.08 12.85 16.08 13.18Q16.08 13.54 15.74 13.54H15.42Q15.34 14.63 14.25 14.63Q13.17 14.63 13.01 13.54H12.21Q11.86 13.54 11.86 13.18Q11.86 12.85 12.21 12.85Z" +
          "M21.2 16.1A.81.81 0 1 0 19.58 16.1A.81.81 0 1 0 21.2 16.1Z"
        }
      />
    </svg>
  );
}
