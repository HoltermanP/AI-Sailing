// Eenvoudige in-memory TTL-cache (LRU-achtig op invoegvolgorde).
// Bewust de simpelste werkende optie: één proces, geen externe afhankelijkheid.
// Voor meerdere instances/edge later te vervangen door Redis/Upstash met
// dezelfde get/set-interface.

export class TtlCache {
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> { value, expires }
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (Date.now() > e.expires) { this.map.delete(key); this.misses++; return undefined; }
    // ververs volgorde (recent gebruikt achteraan)
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}
