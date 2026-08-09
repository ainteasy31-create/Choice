# Chrome Extension Audit & Improvement Plan

## Executive Summary

The Chrome extension successfully captures ~60-70% of available Zillow data. The server-side Python scraper captures ~95%+. This document outlines gaps and provides a roadmap to achieve near-parity.

## Current State Analysis

### What the Extension Captures Well ✅
- Basic property info (address, city, state, zip, beds, baths, sqft)
- Rent and property type
- Photos (6 sources, dedup logic matches server)
- Some amenities from resoFacts
- Pet policies, parking, HVAC, laundry

### Critical Gaps 🔴

#### 1. **Missing Fields (Extension vs Server Scraper)**
| Field | Server | Extension | Impact |
|-------|--------|-----------|--------|
| `lot_size_sqft` | ✅ | ❌ | HIGH - Key property spec |
| `floors/stories` | ✅ | ❌ | HIGH - Important detail |
| `garage_spaces` | ✅ | ❌ | HIGH - Major feature |
| `total_units` | ✅ | ❌ | MEDIUM - Multi-family |
| `has_basement` | ✅ | ❌ | HIGH - Major feature |
| `has_central_air` | ✅ | ❌ | HIGH - Major feature |
| `security_deposit` | ✅ | ❌ | HIGH - Financial |
| `pet_deposit` | ✅ | ❌ | HIGH - Financial |
| `application_fee` | ✅ | ❌ | HIGH - Financial |
| `admin_fee` | ✅ | ❌ | MEDIUM - Financial |
| `parking_fee` | ✅ | ❌ | MEDIUM - Financial |
| `hoa_fee` | ✅ | ❌ | MEDIUM - Financial |
| `last_months_rent` | ✅ | ❌ | MEDIUM - Financial |
| `move_in_special` | ✅ | ❌ | HIGH - Conversion |
| `minimum_lease_months` | ✅ | ❌ | MEDIUM - Policy |
| `smoking_allowed` | ✅ | ❌ | LOW - Policy |
| `pet_weight_limit` | ✅ | ❌ | MEDIUM - Pet policy |
| `pet_details` | ✅ | ❌ | LOW - Pet policy |
| `tax_value` | ✅ | ❌ | LOW - Financial |
| `year_built` | ✅ | ❌ | HIGH - Property spec |
| `virtual_tour_url` | ✅ | ❌ | HIGH - Marketing |
| `agent_name/broker_name` | ✅ | ❌ | LOW - Contact info |

#### 2. **Photo Handling Issues**
- Extension: Photos stored as JSON string in `original_image_urls`
- Problem: No ImageKit transfer happens automatically for extension imports
- Result: Photos show as broken/blocked external URLs in pipeline
- Server scraper: Explicitly uploads to ImageKit via `import-pipeline-photos`

#### 3. **Data Completeness Issues**
- Server scraper enriches from 20+ resoFacts sub-objects
- Extension only captures a subset of resoFacts fields
- Missing: construction materials, roof, foundation, zoning, school district, walk scores, price history

## Proposed Improvements

### Phase 1: Critical Field Coverage (High Priority) 🔴

Update `chrome-extension/shared-extractors.js` to capture ALL fields:

```javascript
// In extractZillow(), add these missing fields:

// Lot & Structure
lot_size_sqft: safeI(prop.lotSizeSquareFeet || rf.lotSizeSquareFeet),
floors: safeI(prop.stories || rf.stories || rf.levels), // with word-to-number mapping
garage_spaces: safeI(prop.garageParkingCapacity || prop.garageSpaces || rf.garageSpaces),
total_units: safeI(prop.unitCount || rf.unitCount || prop.numberOfUnitsTotal),
has_basement: !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'false'),
has_central_air: !!(rf.hasCooling || (rf.cooling && rf.cooling.some(c => c.toLowerCase().includes('central')))),

// Financials
security_deposit: safeI(rf.securityDeposit || prop.securityDeposit),
pet_deposit: safeI(rf.petFee || prop.petFee || rf.petDepositFee),
application_fee: safeI(rf.applicationFee || prop.applicationFee || rf.applicationFeeAmount),
parking_fee: safeI(rf.parkingFee || prop.parkingFee),
hoa_fee: safeI(prop.monthlyHoaFee || prop.hoaFee || rf.monthlyHoaFee || rf.hoaFee),
last_months_rent: safeI(rf.lastMonthRent || rf.lastMonthsRent),
move_in_special: rf.concessions ? String(rf.concessions).slice(0, 200) : null,
tax_value: safeI(prop.taxAnnualAmount || rf.taxAnnualAmount),

// Lease & Policies
minimum_lease_months: parseLeaseMonths(rf.leaseTerm || rf.leaseTerms),
smoking_allowed: rf.smokingAllowed != null ? !!rf.smokingAllowed : null,
pet_weight_limit: safeI(rf.petsMaxWeight || rf.maxPetWeight || rf.petSizeLimit || rf.petWeightLimit),
pet_details: rf.petDetails || prop.petDetails || null,

// Property Specs
year_built: safeInt(prop.yearBuilt || rf.yearBuilt),
virtual_tour_url: prop.virtualTourUrl || prop.threeDimensionalTourUrl || prop.videoTourUrl || null,

// Agent/Broker
agent_name: (prop.attributionInfo && prop.attributionInfo.agentName) || null,
broker_name: (prop.attributionInfo && prop.attributionInfo.brokerName) || null,

// Location Context (NEW)
location_context: buildLocationContext(prop, rf), // walk/transit/bike scores, school district, zoning
```

### Phase 2: Photo Permanence Solution 🖼️

**Problem:** Extension imports store external Zillow URLs that can break.

**Solution Options:**

#### Option A: Auto-trigger ImageKit transfer (RECOMMENDED)
```javascript
// After successful import, if property is published, auto-trigger photo transfer
if (resp.ok && resp.choice_property_id) {
  chrome.runtime.sendMessage({
    type: 'TRANSFER_PHOTOS',
    pipeline_id: resp.id,
    property_id: resp.choice_property_id
  }).catch(() => {}); // Non-blocking
}
```

#### Option B: Store photos in IndexedDB as backup
```javascript
// Cache photos locally in extension storage
await chrome.storage.local.set({
  ['photo_backup_' + payload.source_listing_id]: {
    urls: JSON.parse(payload.original_image_urls),
    timestamp: Date.now()
  }
});
```

#### Option C: Download photos immediately (already exists)
The extension already has `downloadToPC` option. Make it default to `true`.

### Phase 3: Enhanced Data Extraction 📊

Add these NEW extraction functions:

```javascript
function buildLocationContext(prop, rf) {
  const parts = [];
  
  // Walk/transit/bike scores
  const ws = prop.walkScore || (prop.walkScoreData || {}).walkScore;
  const ts = prop.transitScore || (prop.walkScoreData || {}).transitScore;
  const bs = prop.bikeScore || (prop.walkScoreData || {}).bikeScore;
  if (ws != null) parts.push('Walk score: ' + ws);
  if (ts != null) parts.push('Transit score: ' + ts);
  if (bs != null) parts.push('Bike score: ' + bs);
  
  // School district
  const district = rf.schoolDistrict || prop.schoolDistrict;
  if (district) parts.push('School district: ' + district);
  
  // Zoning
  const zoning = rf.zoning || rf.zoningDescription;
  if (zoning) parts.push('Zoning: ' + zoning);
  
  return parts.length ? parts.join('; ') : null;
}

function parseLeaseMonths(leaseTerm) {
  if (!leaseTerm) return null;
  const s = String(leaseTerm).toLowerCase();
  const m = s.match(/(\d+)\s*month/);
  if (m) return parseInt(m[1]);
  if (/month.to.month|m2m|mtm/.test(s)) return 1;
  if (/\byear\b|12[\s-]*month|annual/.test(s)) return 12;
  return null;
}

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''));
  return isNaN(n) || n <= 0 ? null : n;
}
```

### Phase 4: Quality & Reliability Improvements 🛡️

1. **Retry Logic for Failed Extractions**
```javascript
async function handleSaveWithRetry(maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await handleSave();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`[CP] Save attempt ${attempt} failed, retrying...`, err);
      await sleep(1000 * attempt);
    }
  }
}
```

2. **Photo Validation**
```javascript
function validatePhotos(urls) {
  const valid = urls.filter(u => {
    try {
      const url = new URL(u);
      return url.hostname.includes('zillowstatic.com') || 
             url.hostname.includes('zillow.com');
    } catch {
      return false;
    }
  });
  return valid.length > 0 ? valid : urls; // Fallback to all if filter fails
}
```

3. **Field Completeness Check**
```javascript
function checkCompleteness(payload) {
  const criticalFields = [
    'address', 'city', 'state', 'zip', 'monthly_rent', 'bedrooms',
    'bathrooms', 'square_footage', 'property_type', 'description'
  ];
  const missing = criticalFields.filter(f => !payload[f]);
  return missing;
}
```

## Implementation Priority

### MUST FIX (Next Release)
1. Add all missing financial fields (security_deposit, pet_deposit, application_fee, etc.)
2. Add lot_size_sqft, floors, garage_spaces, has_basement, has_central_air
3. Add year_built, virtual_tour_url
4. Auto-trigger ImageKit photo transfer for published listings

### SHOULD FIX (Next Month)
5. Add location_context (walk scores, school district, zoning)
6. Add agent/broker info
7. Improve error handling and retry logic
8. Add photo validation

### NICE TO HAVE (Future)
9. Store photo backups in IndexedDB
10. Add field completeness warnings
11. Support for additional Zillow data (price history, open houses)
12. Offline queue improvements

## Testing Plan

1. **Unit Tests**: Add tests for each new field extraction
2. **Integration Tests**: Compare extension output vs server scraper for 10 listings
3. **Photo Tests**: Verify all photos transfer to ImageKit and display in pipeline
4. **Regression Tests**: Ensure existing functionality still works

## Success Metrics

- **Field Coverage**: Extension captures 90%+ of fields server scraper gets
- **Photo Completeness**: 100% of photos appear in pipeline (via ImageKit)
- **Error Rate**: <5% extraction failures on valid listings
- **User Experience**: No console errors during normal operation

## Deployment Strategy

1. Deploy CORS fix ✅ (DONE)
2. Deploy pipeline photo fix ✅ (DONE)
3. Deploy extension field improvements (THIS REQUEST)
4. Test with 5-10 real listings
5. Deploy to production
6. Monitor error logs for 1 week