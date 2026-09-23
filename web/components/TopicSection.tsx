import Image from "next/image";
import type { SectionPlan } from "@/lib/layout";

interface TopicSectionProps {
  section: SectionPlan;
}

/**
 * A topic's opening screen: the name, and one cover.
 *
 * Deliberately almost wordless. Everything else that used to live here - a
 * generated quote, a two-paragraph summary, "N volumes", a provenance line - is
 * gone. It read like a machine describing a library instead of a library.
 *
 * No hooks and no handlers, so it stays a server-rendered part of the tree.
 */
export default function TopicSection({ section }: TopicSectionProps) {
  const { topic, index } = section;
  const hero = topic.books[topic.heroIndex] ?? topic.books[0];

  return (
    <section
      aria-labelledby={`topic-${topic.slug}`}
      className="relative h-screen shrink-0"
      style={{ width: `${section.widthVw}vw` }}
    >
      {/* Tints the chapter screen with the topic's own colour. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background: `radial-gradient(120% 80% at 18% 50%, ${topic.color}, transparent 72%)`,
        }}
      />

      <div className="editorial-scrim absolute inset-y-0 left-0 grid w-screen grid-cols-12 items-stretch gap-x-[2vw] px-[6vw] pt-[11vh] pb-[17vh]">
        <div className="col-span-12 flex flex-col justify-between md:col-span-7">
          <p className="meta-label text-ink/30">
            {String(index + 1).padStart(2, "0")}
          </p>

          <h2
            id={`topic-${topic.slug}`}
            className="font-serif text-[clamp(1.9rem,9vw,10rem)] leading-[0.86] tracking-[-0.02em] text-ink"
          >
            {topic.name}
          </h2>

          {/* The only affordance the page needs, and it doubles as the hint. */}
          <p className="meta-label text-ink/25">Press ⌘K</p>
        </div>

        <div className="col-span-5 hidden items-end justify-end md:flex">
          {hero ? (
            <div
              className="relative w-[15vw] shrink-0 overflow-hidden"
              style={{ aspectRatio: "2 / 3" }}
            >
              <Image
                src={hero.cover}
                alt=""
                fill
                sizes="15vw"
                className="object-cover"
                priority={index === 0}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
