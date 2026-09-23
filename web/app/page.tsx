import Gallery from "@/components/Gallery";
import { library } from "@/lib/library";
import type { GalleryBook, GalleryPayload, GalleryTopic } from "@/lib/types";

/** Nothing here depends on the request, so Next prerenders the whole page. */
export const dynamic = "force-static";

/**
 * Trim the library down to what the browser actually renders.
 *
 * The full library is ~600 KB, and most of that is the two-paragraph `summary`
 * and the `quote` for all 635 books. The site shows no prose at all, so sending
 * it would be pure waste; this shape is roughly a quarter the size and keeps the
 * per-book records on the server.
 */
function buildPayload(): GalleryPayload {
  const topics: GalleryTopic[] = library.topics.map((topic) => {
    const heroIndex = Math.max(
      0,
      topic.books.findIndex((book) => book.id === topic.featuredId),
    );

    const books: GalleryBook[] = topic.books.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      color: book.color,
      thumb: book.thumb,
      cover: book.cover,
      pages: book.pages,
    }));

    return {
      slug: topic.slug,
      name: topic.name,
      color: topic.color,
      bookCount: topic.bookCount,
      heroIndex,
      books,
    };
  });

  return { topics };
}

export default function Page() {
  return <Gallery payload={buildPayload()} />;
}
