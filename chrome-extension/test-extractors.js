'use strict';
const assert = require('assert');
const api = require('./shared-extractors.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('OK   ' + n); } catch (e) { fail++; console.error('FAIL ' + n + ' - ' + e.message); } };

const doc = (o) => ({ getElementById: (id) => id === '__NEXT_DATA__' ? { textContent: JSON.stringify(o) } : null, querySelectorAll: () => [] });
const cache = (p) => ({ props: { pageProps: { componentProps: { gdpClientCache: JSON.stringify({ k: { property: p } }) } } } });

// --- Fixtures ---
const Z = 'https://www.zillow.com/homedetails/123-Main-St-Dallas-TX-75201/98765432_zpid/';
const ZD = doc(cache({ zpid: 98765432, address: { streetAddress: '123 Main St', city: 'Dallas', state: 'TX', zipcode: '75201' }, price: 1850, bedrooms: 3, bathrooms: 2, livingArea: 1450, yearBuilt: 1998, homeType: 'SINGLE_FAMILY', isPetFriendly: true, walkScore: 78, responsivePhotos: [{ mixedSources: { jpeg: [{ width: 1024, url: 'https://photos.zillowstatic.com/fp/1.jpg' }] } }], attributionInfo: { agentName: 'Jane Agent' }, resoFacts: { dateAvailable: '2026-09-01', securityDeposit: 1850, petsAllowed: true } }));

const R = 'https://www.realtor.com/realestateandhomes-detail/456-Oak-Ave_Austin_TX_78701/M1012345678';
const RD = doc({ props: { pageProps: { initialReduxState: { propertyDetails: { property_id: '1012345678', address: { line: '456 Oak Ave', city: 'Austin', state_code: 'TX', postal_code: '78701' }, price: 2200, beds: 2, baths: 2, sqft: 1100, prop_type: 'condo', photos: [{ href: 'https://ar.rdcpix.com/p1.jpg' }], primary_photo: { href: 'https://ar.rdcpix.com/primary.jpg' } } } } } });

const A = 'https://www.apartments.com/sunset-apartments-houston-tx/abc123/';
const AD = doc({ props: { pageProps: { listing: { id: 'abc123', address: { street: '789 Pine St', city: 'Houston', state: 'TX', zip: '77002' }, price: 1500, bedrooms: 1, bathrooms: 1, squareFeet: 750, photos: [{ url: 'https://images1.apartments.com/a1.jpg' }], petsAllowed: true, availableDate: '2026-07-15' } } } });

const F = 'https://www.redfin.com/TX/Plano/101-Maple-Dr-75074/home/123456789';
const FD = doc({
  props: {
    pageProps: {
      initialReduxState: {
        searchResults: {
          homeDetails: {
            propertyId: 123456789,
            address: { streetAddress: '101 Maple Dr', city: 'Plano', state: 'TX', zip: '75074' },
            beds: 4, baths: 3, sqft: 2100, rent: 2300, propertyType: 'SINGLE_FAMILY',
            photos: [{ url: 'https://ssl.cdn-redfin.com/f1.jpg' }]
          }
        }
      }
    }
  }
});

// --- Tests ---
console.log('CP_Extractors tests\n');
t('detect Zillow', () => assert.strictEqual(api.detect(Z).id, 'zillow'));
t('detect Realtor', () => assert.strictEqual(api.detect(R).id, 'realtor'));
t('detect Apartments', () => assert.strictEqual(api.detect(A).id, 'apartments'));
t('detect Redfin', () => assert.strictEqual(api.detect(F).id, 'redfin'));
t('detect null', () => assert.strictEqual(api.detect('https://fb.com/'), null));
t('Zillow payload', () => { const p = api.extractZillow(ZD, Z); assert.strictEqual(p.source_listing_id, '98765432'); assert.strictEqual(p.address, '123 Main St'); assert.strictEqual(p.monthly_rent, 1850); assert.strictEqual(p.bedrooms, 3); assert.strictEqual(p.bathrooms, 2); assert.strictEqual(p.square_footage, 1450); assert.strictEqual(p.property_type, 'SINGLE_FAMILY'); assert.strictEqual(p.pets_allowed, true); assert.strictEqual(p.available_date, '2026-09-01'); assert.strictEqual(p.security_deposit, 1850); assert.ok(p.location_context.includes('Walk score: 78')); assert.strictEqual(JSON.parse(p.original_image_urls).length, 1); assert.strictEqual(p.agent_name, 'Jane Agent'); });
t('Realtor payload', () => { const p = api.extractRealtor(RD, R); assert.strictEqual(p.source_listing_id, '1012345678'); assert.strictEqual(p.address, '456 Oak Ave'); assert.strictEqual(p.state, 'TX'); assert.strictEqual(p.monthly_rent, 2200); assert.strictEqual(p.bedrooms, 2); assert.strictEqual(p.property_type, 'CONDOS'); const ph = JSON.parse(p.original_image_urls); assert.strictEqual(ph.length, 2); assert.ok(ph[0].includes('primary')); });
t('Apartments payload', () => { const p = api.extractApartments(AD, A); assert.strictEqual(p.source_listing_id, 'abc123'); assert.strictEqual(p.address, '789 Pine St'); assert.strictEqual(p.monthly_rent, 1500); assert.strictEqual(p.property_type, 'APARTMENT'); assert.strictEqual(p.pets_allowed, true); assert.strictEqual(p.available_date, '2026-07-15'); assert.strictEqual(JSON.parse(p.original_image_urls).length, 1); });
t('Redfin payload', () => { const p = api.extractRedfin(FD, F); assert.strictEqual(p.source_listing_id, '123456789'); assert.strictEqual(p.address, '101 Maple Dr'); assert.strictEqual(p.monthly_rent, 2300); assert.strictEqual(p.bedrooms, 4); assert.strictEqual(p.bathrooms, 3); assert.strictEqual(p.property_type, 'SINGLE_FAMILY'); assert.strictEqual(JSON.parse(p.original_image_urls).length, 1); });
t('dispatch', () => { assert.strictEqual(api.extract(Z, ZD).source, 'zillow'); assert.strictEqual(api.extract('https://fb.com/', doc({})), null); });
t('Zillow minimal', () => { const d = doc(cache({ zpid: 111, address: { streetAddress: '1 Empty St', city: 'Nowhere', state: 'TX' }, price: 1000 })); const p = api.extractZillow(d, Z); assert.ok(p); assert.strictEqual(p.monthly_rent, 1000); assert.strictEqual(p.bedrooms, null); assert.strictEqual(p.security_deposit, null); });

// --- Photo dedup ---
const ZDUP = doc(cache({
  zpid: 98765432,
  address: { streetAddress: '123 Main St', city: 'Dallas', state: 'TX', zipcode: '75201' },
  price: 1850, bedrooms: 3, bathrooms: 2, livingArea: 1450, yearBuilt: 1998,
  homeType: 'SINGLE_FAMILY',
  responsivePhotos: [
    { mixedSources: { jpeg: [{ width: 1536, url: 'https://photos.zillowstatic.com/fp/aaa111bbb222ccc333ddd444eee555fff-uncropped_scaled_within_1536_1152.jpg' }] } },
    { mixedSources: { jpeg: [{ width: 1536, url: 'https://photos.zillowstatic.com/fp/aaa111bbb222ccc333ddd444eee555fff-cc_ft_1536.jpg' }] } },
    { mixedSources: { jpeg: [{ width: 1536, url: 'https://photos.zillowstatic.com/fp/aaa111bbb222ccc333ddd444eee555fff-p_h.jpg' }] } },
    { mixedSources: { jpeg: [{ width: 1536, url: 'https://photos.zillowstatic.com/fp/9ce6ff107193275cd385d1332a79ba02-uncropped_scaled_within_1536_1152.jpg' }] } },
    { mixedSources: { jpeg: [{ width: 1536, url: 'https://photos.zillowstatic.com/fp/9ce6ff107193275cd385d1332a79ba02-cc_ft_1536.jpg' }] } },
  ],
}));
t('Zillow photo dedup', () => {
  const p = api.extractZillow(ZDUP, Z);
  const urls = JSON.parse(p.original_image_urls);
  assert.strictEqual(urls.length, 2, 'should dedup 5 URLs to 2 unique hashes');
  assert.ok(urls[0].includes('uncropped_scaled_within_1536_1152'), 'should keep highest-res variant');
  assert.ok(urls[1].includes('uncropped_scaled_within_1536_1152'), 'should keep highest-res variant for 2nd hash');
});

// --- Source URL validation ---
const ZBAD = 'https://www.zillow.com/homedetails/8907-Meadow-Vista-Blvd-Houston-TX-77064/439698245_zpid/';
const ZGOOD = 'https://www.zillow.com/homedetails/123-Main-St-Dallas-TX-75201/98765432_zpid/';
t('Zillow URL zpid mismatch fix', () => {
  const p = api.extractZillow(ZD, ZBAD);
  assert.ok(p.source_url.includes('98765432_zpid'), 'should rebuild URL with data zpid, got: ' + p.source_url);
  assert.ok(!p.source_url.includes('439698245'), 'should not keep stale zpid');
});
t('Zillow URL zpid match passthrough', () => {
  const p = api.extractZillow(ZD, ZGOOD);
  assert.strictEqual(p.source_url, ZGOOD, 'should keep URL when zpid matches');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
