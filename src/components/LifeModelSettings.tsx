import { STRINGS } from "../runtime/strings";

export function LifeModelSettings() {
  return (
    <>
      <div className="s-h">{STRINGS.lifemodel.heading}</div>
      <div className="s-sub">{STRINGS.lifemodel.sub}</div>

      <div className="lm-master">
        <div>
          <div className="lm-t">{STRINGS.lifemodel.masterTitle}</div>
          <div className="lm-d">{STRINGS.lifemodel.masterDesc}</div>
        </div>
        <span className="lm-soon">{STRINGS.lifemodel.comingSoon}</span>
        <button type="button" className="tog" disabled aria-pressed={false} />
      </div>
      <div className="lm-honest">{STRINGS.lifemodel.disabledNote}</div>

      <div className="s-sec-label">{STRINGS.lifemodel.proposalLabel}</div>
      <div className="lm-card">
        <div className="lm-empty">{STRINGS.lifemodel.proposalEmpty}</div>
      </div>

      <div className="s-sec-label">{STRINGS.lifemodel.canonicalLabel}</div>
      <div className="lm-card">
        <div className="lm-empty">{STRINGS.lifemodel.canonicalEmpty}</div>
      </div>

      <div className="s-sec-label">{STRINGS.lifemodel.injectLabel}</div>
      <div className="lm-card">
        <div className="lm-empty">{STRINGS.lifemodel.injectEmpty}</div>
        <div className="lm-example">
          <span className="lm-chip">{STRINGS.lifemodel.injectExample}</span>
          <span className="lm-tag">{STRINGS.lifemodel.injectExampleLabel}</span>
        </div>
        <div className="lm-note">{STRINGS.lifemodel.injectExampleNote}</div>
      </div>
    </>
  );
}
