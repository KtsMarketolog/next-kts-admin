import type { CSSProperties } from "react";

const fallbackRootStyle: CSSProperties = {
  width: "100%",
};

const groupShellStyle: CSSProperties = {
  width: "100%",
  maxWidth: "1600px",
  minHeight: "260px",
  margin: "0 auto",
  padding: "clamp(56px, 6.8vw, 130px) 18px clamp(56px, 5.8vw, 110px)",
};

const headingStyle: CSSProperties = {
  width: "min(520px, 68vw)",
  height: "clamp(68px, 4.8vw, 92px)",
  margin: "0 auto 32px",
  borderRadius: "16px",
  background: "linear-gradient(90deg, #f7f7fb 0%, #f0eff8 48%, #f7f7fb 100%)",
};

const groupCardsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: "25px",
};

const groupCardStyle: CSSProperties = {
  minHeight: "clamp(120px, 8.2vw, 156px)",
  border: "3px solid #1b0389",
  borderRadius: "21px",
  background: "linear-gradient(135deg, #ffffff 0%, #f8f7ff 100%)",
};

const aboutShellStyle: CSSProperties = {
  width: "100%",
  maxWidth: "1274px",
  minHeight: "680px",
  margin: "0 auto",
  padding: "0 18px clamp(64px, 6.8vw, 130px)",
};

const aboutTitleStyle: CSSProperties = {
  width: "min(360px, 60vw)",
  height: "64px",
  margin: "0 auto 40px",
  borderRadius: "16px",
  background: "linear-gradient(90deg, #f7f7fb 0%, #f0eff8 48%, #f7f7fb 100%)",
};

const aboutGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
  gap: "34px",
};

const aboutBigStyle: CSSProperties = {
  minHeight: "clamp(340px, 29.5vw, 566px)",
  borderRadius: "15px",
  background: "linear-gradient(179.92deg, #240c96 27.06%, #604fad 99.93%)",
};

const factsStyle: CSSProperties = {
  display: "grid",
  gap: "34px",
};

const factStyle: CSSProperties = {
  minHeight: "clamp(118px, 8.7vw, 166px)",
  borderRadius: "15px",
  background: "#e9e6f4",
};

export function HomeDeferredSectionsFallback() {
  return (
    <div aria-hidden="true" style={fallbackRootStyle}>
      <section style={groupShellStyle}>
        <div style={headingStyle} />
        <div style={groupCardsStyle}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} style={groupCardStyle} />
          ))}
        </div>
      </section>

      <section style={aboutShellStyle}>
        <div style={aboutTitleStyle} />
        <div style={aboutGridStyle}>
          <div style={aboutBigStyle} />
          <div style={factsStyle}>
            <div style={factStyle} />
            <div style={factStyle} />
            <div style={factStyle} />
          </div>
        </div>
      </section>
    </div>
  );
}
