import { STRINGS } from "../runtime/strings";
import { SETTINGS_PRESENTATION } from "../runtime/settings_presentation_strings";
import "../lifemodel-settings.css";
import {
  BookOpenIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
} from "@phosphor-icons/react";

export function LifeModelSettings() {
  const P = SETTINGS_PRESENTATION.life;
  const icons = [BookOpenIcon, ShieldCheckIcon, SlidersHorizontalIcon];
  return (
    <div className="lifemodel-page">
      <header className="general-heading">
        <h1>{STRINGS.lifemodel.heading}</h1>
        <p>{P.sub}</p>
      </header>
      <section className="lifemodel-boundary">
        <SparkleIcon size={28} aria-hidden="true" />
        <h2>{P.title}</h2>
        <span className="lifemodel-badge">{P.badge}</span>
        <p>{P.description}</p>
        <div className="lifemodel-principles">
          {P.principles.map(({ title, text }, index) => {
            const Icon = icons[index];
            return (
              <article key={title}>
                <Icon size={20} aria-hidden="true" />
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
