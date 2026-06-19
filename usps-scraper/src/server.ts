import { scrapeUspsTracking } from "./scrape.js";
import { scrapeUniuniTracking } from "./uniuni.js";
import { scrapeUpsTracking } from "./ups.js";
import { scrapeYunexpressTracking } from "./scrape-yunexpress.js";
import { importAmazonShipments } from "./amazon.js";
import { createScraperServer } from "./server-app.js";

const port = Number(process.env.PORT ?? "8790");
const server = createScraperServer({
  usps: scrapeUspsTracking,
  uniuni: scrapeUniuniTracking,
  ups: scrapeUpsTracking,
  yunexpress: scrapeYunexpressTracking,
  amazonImport: importAmazonShipments,
});

server.listen(port, () => {
  process.stdout.write(`Paqq scraper service listening on port ${port}\n`);
});
