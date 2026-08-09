#!/usr/bin/env python3
"""
Choice Properties — Zillow Scraping Services (v1)
==================================================
Abstraction layer for multiple Zillow scraping services with fallback support.

Supported services:
  - Apify (apify.com) - Pre-built Zillow actors, ~$5/month free credit
  - ScrapeBadger (scrapebadger.com) - Pre-built Zillow scrapers, free tier available
  - Oxylabs (oxylabs.io) - Enterprise-grade proxy scraping, trial credits available
  - Direct (existing zillow_scraper.py) - Direct HTML parsing, requires residential IP

Usage:
  from zillow_services import scrape_zillow_with_service
  records, blocked, service_used = scrape_zillow_with_service(
      location="Dallas, TX",
      service="apify",  # or "scrapebadger", "oxylabs", "direct", "auto"
      limit=200,
      verbose=True
  )

Environment variables (.env):
  APIFY_API_TOKEN              (for Apify service)
  SCRAPEBADGER_API_TOKEN       (for ScrapeBadger service)
  OXYLABS_USERNAME             (for Oxylabs service)
  OXYLABS_PASSWORD             (for Oxylabs service)
  ZILLOW_SCRAPER_SERVICE       (default service: "auto", "direct", "apify", "scrapebadger", "oxylabs")
"""

import os
import json
import time
import random
from typing import List, Dict, Any, Optional, Tuple

# ── Service priority order for "auto" mode ─────────────────────────────────────
_SERVICE_PRIORITY = ["apify", "scrapebadger", "oxylabs", "direct"]

# ── Configuration ──────────────────────────────────────────────────────────────

def _get_config():
    """Load service configuration from environment variables."""
    return {
        "apify": {
            "api_token": os.environ.get("APIFY_API_TOKEN", ""),
            "enabled": bool(os.environ.get("APIFY_API_TOKEN")),
            "actor_id": os.environ.get("APIFY_ZILLOW_ACTOR", "apify/zillow-scraper"),
        },
        "scrapebadger": {
            "api_token": os.environ.get("SCRAPEBADGER_API_TOKEN", ""),
            "enabled": bool(os.environ.get("SCRAPEBADGER_API_TOKEN")),
            "base_url": "https://scrapebadger.com/api/v1",
        },
        "oxylabs": {
            "username": os.environ.get("OXYLABS_USERNAME", ""),
            "password": os.environ.get("OXYLABS_PASSWORD", ""),
            "enabled": bool(os.environ.get("OXYLABS_USERNAME") and os.environ.get("OXYLABS_PASSWORD")),
            "base_url": "https://realtime.oxylabs.io/v1/queries",
        },
        "direct": {
            "enabled": True,  # Always available as fallback
        },
    }


def _get_default_service():
    """Get the default service from environment or 'auto'."""
    return os.environ.get("ZILLOW_SCRAPER_SERVICE", "auto").lower()


# ── Base scraper interface ──────────────────────────────────────────────────────

class ZillowScraperService:
    """Base class for Zillow scraping services."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.service_name = "base"
    
    def is_available(self) -> bool:
        """Check if this service is properly configured."""
        return False
    
    def scrape(
        self,
        location: str,
        limit: int = 200,
        beds_min: Optional[int] = None,
        beds_max: Optional[int] = None,
        price_min: Optional[int] = None,
        price_max: Optional[int] = None,
        verbose: bool = False,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """
        Scrape Zillow listings.
        
        Returns:
            (records, blocked) where:
              - records: list of pipeline_properties-compatible dicts
              - blocked: True if bot detection was triggered
        """
        raise NotImplementedError
    
    def _normalize_record(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize raw service data to pipeline_properties format."""
        raise NotImplementedError


# ── Apify service ──────────────────────────────────────────────────────────────

class ApifyService(ZillowScraperService):
    """Zillow scraping via Apify platform."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.service_name = "apify"
        self.api_token = config.get("apify", {}).get("api_token", "")
        self.actor_id = config.get("apify", {}).get("actor_id", "apify/zillow-scraper")
    
    def is_available(self) -> bool:
        return bool(self.api_token)
    
    def scrape(
        self,
        location: str,
        limit: int = 200,
        beds_min: Optional[int] = None,
        beds_max: Optional[int] = None,
        price_min: Optional[int] = None,
        price_max: Optional[int] = None,
        verbose: bool = False,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Scrape Zillow via Apify actor."""
        if not self.is_available():
            if verbose:
                print("  [Apify] Not configured — set APIFY_API_TOKEN in .env")
            return [], False
        
        try:
            import requests as req
        except ImportError:
            if verbose:
                print("  [Apify] requests library not installed")
            return [], False
        
        if verbose:
            print(f"  [Apify] Starting scrape for: {location}")
            print(f"  [Apify] Actor: {self.actor_id}")
        
        # Build actor input
        search_url = f"https://www.zillow.com/homes/for_rent/{location.replace(', ', '-').replace(',', '-').replace(' ', '-')}/"
        
        actor_input = {
            "startUrls": [{"url": search_url}],
            "maxItems": limit,
            "proxy": {
                "useApifyProxy": True,
                "apifyProxyGroups": ["RESIDENTIAL"],
            },
            "scrapeOptions": {
                "extractPhotos": True,
                "extractPropertyDetails": True,
            }
        }
        
        # Start actor run
        headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }
        
        # Trigger actor
        run_url = f"https://api.apify.com/v2/acts/{self.actor_id}/runs"
        
        try:
            resp = req.post(run_url, json=actor_input, headers=headers, timeout=30)
            if resp.status_code != 201:
                if verbose:
                    print(f"  [Apify] Failed to start actor: {resp.status_code} - {resp.text[:200]}")
                return [], False
            
            run_data = resp.json()
            run_id = run_data.get("data", {}).get("id")
            
            if not run_id:
                if verbose:
                    print("  [Apify] No run ID returned")
                return [], False
            
            if verbose:
                print(f"  [Apify] Run started: {run_id}")
            
            # Poll for completion
            dataset_url = f"https://api.apify.com/v2/acts/{self.actor_id}/runs/{run_id}/dataset/items"
            max_wait = 300  # 5 minutes max
            wait_time = 0
            
            while wait_time < max_wait:
                time.sleep(5)
                wait_time += 5
                
                status_resp = req.get(
                    f"https://api.apify.com/v2/actor-runs/{run_id}",
                    headers=headers,
                    timeout=10
                )
                if status_resp.status_code == 200:
                    status_data = status_resp.json()
                    status = status_data.get("data", {}).get("status", "")
                    
                    if verbose and wait_time % 15 == 0:
                        print(f"  [Apify] Status: {status} (waited {wait_time}s)")
                    
                    if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
                        break
            
            # Fetch results
            if wait_time >= max_wait:
                if verbose:
                    print("  [Apify] Timeout waiting for results")
                return [], False
            
            result_resp = req.get(dataset_url, headers=headers, timeout=30)
            if result_resp.status_code != 200:
                if verbose:
                    print(f"  [Apify] Failed to fetch results: {result_resp.status_code}")
                return [], False
            
            raw_listings = result_resp.json()
            if not isinstance(raw_listings, list):
                raw_listings = []
            
            if verbose:
                print(f"  [Apify] Received {len(raw_listings)} listings")
            
            # Normalize to pipeline format
            records = []
            for raw in raw_listings[:limit]:
                try:
                    rec = self._normalize_record(raw)
                    if rec:
                        records.append(rec)
                except Exception as e:
                    if verbose:
                        print(f"  [Apify] Failed to normalize record: {e}")
                    continue
            
            return records, False
            
        except Exception as e:
            if verbose:
                print(f"  [Apify] Error: {e}")
            return [], False
    
    def _normalize_record(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize Apify Zillow output to pipeline_properties format."""
        # Apify Zillow scraper returns data in a specific format
        # Adapt this based on actual Apify actor output structure
        
        address = raw.get("address") or {}
        if isinstance(address, str):
            # Parse address string if needed
            address = {}
        
        street = address.get("streetAddress") or raw.get("streetAddress") or raw.get("address")
        city = address.get("city") or raw.get("city")
        state = address.get("state") or raw.get("state")
        zipcode = address.get("zipcode") or raw.get("zipcode") or raw.get("zip")
        
        # Price
        price = raw.get("price") or raw.get("unformattedPrice")
        if isinstance(price, str):
            import re
            m = re.search(r"[\d,]+", price.replace(",", ""))
            price = int(m.group(0)) if m else None
        elif isinstance(price, (int, float)):
            price = int(price)
        
        # Bedrooms/bathrooms
        beds = raw.get("bedrooms") or raw.get("beds")
        baths = raw.get("bathrooms") or raw.get("baths")
        
        # Property type
        home_type = (raw.get("homeType") or raw.get("propertyType") or "").upper()
        type_map = {
            "SINGLE_FAMILY": "SINGLE_FAMILY",
            "MULTI_FAMILY": "MULTI_FAMILY",
            "CONDO": "CONDOS",
            "CONDO_TOWNHOME": "CONDOS",
            "TOWNHOUSE": "TOWNHOMES",
            "APARTMENT": "APARTMENT",
            "MANUFACTURED": "MOBILE",
            "MOBILE": "MOBILE",
        }
        prop_type = type_map.get(home_type)
        
        # Photos
        photos = []
        for key in ["photos", "images", "imgSrc", "carouselPhotos"]:
            val = raw.get(key)
            if isinstance(val, list):
                for p in val:
                    if isinstance(p, str) and p.startswith("http"):
                        photos.append(p)
                    elif isinstance(p, dict):
                        url = p.get("url") or p.get("src") or p.get("href")
                        if url and url.startswith("http"):
                            photos.append(url)
            elif isinstance(val, str) and val.startswith("http"):
                photos.append(val)
        
        # Deduplicate
        photos = list(dict.fromkeys(photos))[:50]
        
        # Description
        desc = raw.get("description") or raw.get("descriptionText") or ""
        
        # ZPID
        zpid = str(raw.get("zpid") or raw.get("id") or "")
        
        # Build title
        bed_pfx = f"{beds}BR " if beds else ""
        type_lbl = (prop_type or "Rental").replace("_", " ").title()
        title = f"{bed_pfx}{type_lbl} in {city}" if city else (street or "Zillow Rental")
        
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        
        record = {
            "id": "PP-" + __import__('uuid').uuid4().hex[:8].upper(),
            "source": "zillow",
            "source_url": raw.get("url") or raw.get("detailUrl") or raw.get("link") or "",
            "source_listing_id": zpid,
            "status": "scraped",
            "title": title,
            "address": street,
            "unit_number": None,
            "city": city,
            "state": state,
            "zip": zipcode,
            "county": None,
            "neighborhood": raw.get("neighborhood") or raw.get("neighborhoodName"),
            "lat": raw.get("lat") or raw.get("latitude"),
            "lng": raw.get("lng") or raw.get("longitude"),
            "location_context": None,
            "property_type": prop_type,
            "bedrooms": beds,
            "bathrooms": baths if baths is not None else None,
            "half_bathrooms": 1 if baths is not None and baths != int(baths) else None,
            "total_bathrooms": baths,
            "square_footage": raw.get("livingArea") or raw.get("sqft") or raw.get("area"),
            "lot_size_sqft": raw.get("lotSizeSquareFeet"),
            "year_built": raw.get("yearBuilt"),
            "floors": raw.get("stories") or raw.get("levels"),
            "garage_spaces": raw.get("garageSpaces"),
            "total_units": raw.get("unitCount") or raw.get("numberOfUnitsTotal"),
            "has_basement": None,
            "has_central_air": None,
            "virtual_tour_url": raw.get("virtualTourUrl") or raw.get("threeDimensionalTourUrl"),
            "monthly_rent": price,
            "security_deposit": raw.get("securityDeposit"),
            "last_months_rent": None,
            "application_fee": raw.get("applicationFee"),
            "pet_deposit": raw.get("petFee"),
            "admin_fee": raw.get("adminFee"),
            "move_in_special": raw.get("specialOffers") or raw.get("concessions"),
            "parking_fee": raw.get("parkingFee"),
            "hoa_fee": raw.get("monthlyHoaFee") or raw.get("hoaFee"),
            "tax_value": raw.get("taxAnnualAmount"),
            "description": desc[:2000] if desc else None,
            "showing_instructions": None,
            "available_date": None,
            "minimum_lease_months": None,
            "lease_terms": "[]",
            "pets_allowed": raw.get("isPetFriendly") or raw.get("petsAllowed"),
            "pet_types_allowed": "[]",
            "pet_weight_limit": None,
            "pet_details": None,
            "smoking_allowed": None,
            "parking": raw.get("parkingType"),
            "amenities": json.dumps(raw.get("tags") or []),
            "appliances": "[]",
            "utilities_included": "[]",
            "flooring": "[]",
            "heating_type": None,
            "cooling_type": None,
            "laundry_type": None,
            "original_image_urls": json.dumps(photos),
            "local_image_paths": "[]",
            "agent_name": raw.get("agentName") or raw.get("brokerName"),
            "broker_name": raw.get("brokerName") or raw.get("officeName"),
            "agent_image_url": None,
            "poster_landlord_id": None,
            "original_data": json.dumps({
                "zpid": zpid,
                "detailUrl": raw.get("url") or raw.get("detailUrl"),
                "_source": "zillow",
                "_service": "apify",
                "_imported_at": now,
            }, default=str),
            "edited_fields": "[]",
            "inferred_features": "[]",
            "data_quality_score": 50,  # Will be recalculated
            "missing_fields": "[]",
            "published_at": None,
            "choice_property_id": None,
            "scraped_at": now,
            "updated_at": now,
        }
        
        # Calculate quality score
        _CORE_FIELDS = [
            "address", "city", "state", "zip", "lat", "lng",
            "bedrooms", "bathrooms", "square_footage", "monthly_rent",
            "property_type", "description", "available_date",
        ]
        _BONUS_FIELDS = [
            "county", "neighborhood", "year_built", "parking",
            "pets_allowed", "security_deposit", "amenities", "appliances",
            "heating_type", "cooling_type", "laundry_type",
        ]
        
        score = 0
        for field in _CORE_FIELDS:
            if record.get(field) not in (None, "", "[]"):
                score += 6
        for field in _BONUS_FIELDS:
            if record.get(field) not in (None, "", "[]"):
                score += 2
        try:
            n = len(json.loads(record.get("original_image_urls") or "[]"))
        except Exception:
            n = 0
        score += 6 if n >= 5 else 3 if n >= 1 else 0
        record["data_quality_score"] = min(score, 100)
        
        # Missing fields
        _TRACKABLE_MISSING = [
            "lat", "lng", "county", "neighborhood", "year_built", "square_footage",
            "parking", "pets_allowed", "security_deposit", "amenities", "appliances",
            "available_date", "heating_type", "cooling_type", "laundry_type",
        ]
        record["missing_fields"] = json.dumps([f for f in _TRACKABLE_MISSING if record.get(f) in (None, "", "[]")])
        
        return record


# ── ScrapeBadger service ────────────────────────────────────────────────────────

class ScrapeBadgerService(ZillowScraperService):
    """Zillow scraping via ScrapeBadger API."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.service_name = "scrapebadger"
        self.api_token = config.get("scrapebadger", {}).get("api_token", "")
        self.base_url = config.get("scrapebadger", {}).get("base_url", "https://scrapebadger.com/api/v1")
    
    def is_available(self) -> bool:
        return bool(self.api_token)
    
    def scrape(
        self,
        location: str,
        limit: int = 200,
        beds_min: Optional[int] = None,
        beds_max: Optional[int] = None,
        price_min: Optional[int] = None,
        price_max: Optional[int] = None,
        verbose: bool = False,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Scrape Zillow via ScrapeBadger API."""
        if not self.is_available():
            if verbose:
                print("  [ScrapeBadger] Not configured — set SCRAPEBADGER_API_TOKEN in .env")
            return [], False
        
        try:
            import requests as req
        except ImportError:
            if verbose:
                print("  [ScrapeBadger] requests library not installed")
            return [], False
        
        if verbose:
            print(f"  [ScrapeBadger] Starting scrape for: {location}")
        
        headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }
        
        # Build search URL
        slug = location.strip().replace(", ", ",-").replace(",", ",-").replace(" ", "-")
        slug = re.sub(r"-{2,}", "-", slug)
        search_url = f"https://www.zillow.com/homes/for_rent/{slug}/"
        
        # ScrapeBadger API payload
        payload = {
            "url": search_url,
            "format": "json",
            "extract": {
                "listings": {
                    "selector": "div[class*='property']",
                    "extract": {
                        "address": ".propertyAddress::text",
                        "price": ".detailPrice::text",
                        "beds": "text:Bedrooms",
                        "baths": "text:Bathrooms",
                        "type": "text:Type",
                        "description": ".propertyDescription::text",
                        "photos": "img::attr(src)",
                    }
                }
            }
        }
        
        try:
            resp = req.post(
                f"{self.base_url}/scrape",
                json=payload,
                headers=headers,
                timeout=60
            )
            
            if resp.status_code != 200:
                if verbose:
                    print(f"  [ScrapeBadger] API error: {resp.status_code} - {resp.text[:200]}")
                return [], False
            
            data = resp.json()
            raw_listings = data.get("listings", [])
            
            if verbose:
                print(f"  [ScrapeBadger] Received {len(raw_listings)} listings")
            
            # Normalize records
            records = []
            for raw in raw_listings[:limit]:
                try:
                    rec = self._normalize_record(raw, location)
                    if rec:
                        records.append(rec)
                except Exception as e:
                    if verbose:
                        print(f"  [ScrapeBadger] Failed to normalize record: {e}")
                    continue
            
            return records, False
            
        except Exception as e:
            if verbose:
                print(f"  [ScrapeBadger] Error: {e}")
            return [], False
    
    def _normalize_record(self, raw: Dict[str, Any], location: str) -> Dict[str, Any]:
        """Normalize ScrapeBadger output to pipeline format."""
        # This is a simplified normalizer - adjust based on actual ScrapeBadger response format
        import re
        from datetime import datetime
        
        address = raw.get("address", "")
        price_str = raw.get("price", "")
        beds = raw.get("beds")
        baths = raw.get("baths")
        desc = raw.get("description", "")
        
        # Parse price
        price = None
        if price_str:
            m = re.search(r"[\d,]+", str(price_str).replace(",", ""))
            price = int(m.group(0)) if m else None
        
        # Parse beds/baths
        if isinstance(beds, str):
            m = re.search(r"\d+", beds)
            beds = int(m.group(0)) if m else None
        if isinstance(baths, str):
            m = re.search(r"[\d.]+", baths)
            baths = float(m.group(0)) if m else None
        
        # Photos
        photos = []
        for p in (raw.get("photos") or []):
            if isinstance(p, str) and p.startswith("http"):
                photos.append(p)
        photos = list(dict.fromkeys(photos))[:50]
        
        now = datetime.utcnow().isoformat() + "Z"
        
        record = {
            "id": "PP-" + __import__('uuid').uuid4().hex[:8].upper(),
            "source": "zillow",
            "source_url": raw.get("url") or raw.get("detailUrl") or "",
            "source_listing_id": str(raw.get("zpid") or raw.get("id") or ""),
            "status": "scraped",
            "title": f"{beds}BR Rental in {location}" if beds else address or "Zillow Rental",
            "address": address,
            "unit_number": None,
            "city": None,
            "state": None,
            "zip": None,
            "county": None,
            "neighborhood": None,
            "lat": None,
            "lng": None,
            "location_context": None,
            "property_type": None,
            "bedrooms": beds,
            "bathrooms": baths if baths is not None else None,
            "half_bathrooms": 1 if baths is not None and baths != int(baths) else None,
            "total_bathrooms": baths,
            "square_footage": None,
            "lot_size_sqft": None,
            "year_built": None,
            "floors": None,
            "garage_spaces": None,
            "total_units": None,
            "has_basement": None,
            "has_central_air": None,
            "virtual_tour_url": None,
            "monthly_rent": price,
            "security_deposit": None,
            "last_months_rent": None,
            "application_fee": None,
            "pet_deposit": None,
            "admin_fee": None,
            "move_in_special": None,
            "parking_fee": None,
            "hoa_fee": None,
            "tax_value": None,
            "description": desc[:2000] if desc else None,
            "showing_instructions": None,
            "available_date": None,
            "minimum_lease_months": None,
            "lease_terms": "[]",
            "pets_allowed": None,
            "pet_types_allowed": "[]",
            "pet_weight_limit": None,
            "pet_details": None,
            "smoking_allowed": None,
            "parking": raw.get("parking"),
            "amenities": json.dumps(raw.get("amenities") or []),
            "appliances": "[]",
            "utilities_included": "[]",
            "flooring": "[]",
            "heating_type": None,
            "cooling_type": None,
            "laundry_type": None,
            "original_image_urls": json.dumps(photos),
            "local_image_paths": "[]",
            "agent_name": None,
            "broker_name": None,
            "agent_image_url": None,
            "poster_landlord_id": None,
            "original_data": json.dumps({
                "_source": "zillow",
                "_service": "scrapebadger",
                "_imported_at": now,
            }, default=str),
            "edited_fields": "[]",
            "inferred_features": "[]",
            "data_quality_score": 30,
            "missing_fields": "[]",
            "published_at": None,
            "choice_property_id": None,
            "scraped_at": now,
            "updated_at": now,
        }
        
        # Calculate quality score
        _CORE_FIELDS = [
            "address", "city", "state", "zip", "lat", "lng",
            "bedrooms", "bathrooms", "square_footage", "monthly_rent",
            "property_type", "description", "available_date",
        ]
        _BONUS_FIELDS = [
            "county", "neighborhood", "year_built", "parking",
            "pets_allowed", "security_deposit", "amenities", "appliances",
            "heating_type", "cooling_type", "laundry_type",
        ]
        
        score = 0
        for field in _CORE_FIELDS:
            if record.get(field) not in (None, "", "[]"):
                score += 6
        for field in _BONUS_FIELDS:
            if record.get(field) not in (None, "", "[]"):
                score += 2
        try:
            n = len(json.loads(record.get("original_image_urls") or "[]"))
        except Exception:
            n = 0
        score += 6 if n >= 5 else 3 if n >= 1 else 0
        record["data_quality_score"] = min(score, 100)
        
        _TRACKABLE_MISSING = [
            "lat", "lng", "county", "neighborhood", "year_built", "square_footage",
            "parking", "pets_allowed", "security_deposit", "amenities", "appliances",
            "available_date", "heating_type", "cooling_type", "laundry_type",
        ]
        record["missing_fields"] = json.dumps([f for f in _TRACKABLE_MISSING if record.get(f) in (None, "", "[]")])
        
        return record


# ── Oxylabs service ─────────────────────────────────────────────────────────────

class OxylabsService(ZillowScraperService):
    """Zillow scraping via Oxylabs Scraper API."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.service_name = "oxylabs"
        self.username = config.get("oxylabs", {}).get("username", "")
        self.password = config.get("oxylabs", {}).get("password", "")
        self.base_url = config.get("oxylabs", {}).get("base_url", "https://realtime.oxylabs.io/v1/queries")
    
    def is_available(self) -> bool:
        return bool(self.username and self.password)
    
    def scrape(
        self,
        location: str,
        limit: int = 200,
        beds_min: Optional[int] = None,
        beds_max: Optional[int] = None,
        price_min: Optional[int] = None,
        price_max: Optional[int] = None,
        verbose: bool = False,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Scrape Zillow via Oxylabs Real-Time Scraper API."""
        if not self.is_available():
            if verbose:
                print("  [Oxylabs] Not configured — set OXYLABS_USERNAME and OXYLABS_PASSWORD in .env")
            return [], False
        
        try:
            import requests as req
            import base64
        except ImportError:
            if verbose:
                print("  [Oxylabs] requests library not installed")
            return [], False
        
        if verbose:
            print(f"  [Oxylabs] Starting scrape for: {location}")
        
        # Build search URL
        slug = location.strip().replace(", ", ",-").replace(",", ",-").replace(" ", "-")
        slug = re.sub(r"-{2,}", "-", slug)
        search_url = f"https://www.zillow.com/homes/for_rent/{slug}/"
        
        # Oxylabs Real-Time Scraper API payload
        payload = {
            "url": search_url,
            "geo_location": "United States",
            "locale": "en-US",
        }
        
        # Basic auth with Oxylabs credentials
        auth = (self.username, self.password)
        
        try:
            resp = req.post(
                self.base_url,
                auth=auth,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=120  # Oxylabs can take longer
            )
            
            if resp.status_code != 200:
                if verbose:
                    print(f"  [Oxylabs] API error: {resp.status_code} - {resp.text[:200]}")
                return [], False
            
            data = resp.json()
            
            # Oxylabs returns the scraped page content
            # We need to extract listings from the HTML/JSON
            html = data.get("body", "") or data.get("html", "")
            
            if not html:
                if verbose:
                    print("  [Oxylabs] No content returned")
                return [], False
            
            if verbose:
                print(f"  [Oxylabs] Received {len(html)} bytes of content")
            
            # Extract __NEXT_DATA__ from HTML (same as direct scraper)
            import re as _re
            m = _re.search(
                r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>\s*(.*?)\s*</script>',
                html, _re.DOTALL
            )
            if not m:
                if verbose:
                    print("  [Oxylabs] No __NEXT_DATA__ found in response")
                return [], False
            
            try:
                nd = json.loads(m.group(1))
            except Exception:
                if verbose:
                    print("  [Oxylabs] Failed to parse __NEXT_DATA__")
                return [], False
            
            # Extract listings array (same paths as zillow_scraper.py)
            listings = []
            for path in [
                ("props", "pageProps", "searchPageState", "cat1", "searchResults", "listResults"),
                ("props", "pageProps", "searchPageState", "cat2", "searchResults", "mapResults"),
                ("props", "pageProps", "componentProps", "listResults"),
                ("props", "pageProps", "searchResults", "listResults"),
            ]:
                try:
                    node = nd
                    for k in path:
                        node = node[k]
                    if isinstance(node, list) and node:
                        listings = node
                        break
                except (KeyError, TypeError):
                    continue
            
            if not listings:
                if verbose:
                    print("  [Oxylabs] No listings found in __NEXT_DATA__")
                return [], False
            
            if verbose:
                print(f"  [Oxylabs] Found {len(listings)} listings in data")
            
            # Normalize records (reuse the same logic as Apify)
            records = []
            for raw in listings[:limit]:
                try:
                    rec = self._normalize_record(raw)
                    if rec:
                        records.append(rec)
                except Exception as e:
                    if verbose:
                        print(f"  [Oxylabs] Failed to normalize record: {e}")
                    continue
            
            return records, False
            
        except Exception as e:
            if verbose:
                print(f"  [Oxylabs] Error: {e}")
            return [], False
    
    def _normalize_record(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize Oxylabs output (same format as direct Zillow scraper)."""
        # Reuse the same normalizer as direct scraper
        # Import from zillow_scraper if available
        try:
            from zillow_scraper import _map_listing
            return _map_listing(raw)
        except ImportError:
            # Fallback to basic normalization
            return ApifyService._normalize_record(self, raw)


# ── Direct service (existing zillow_scraper.py) ────────────────────────────────

class DirectService(ZillowScraperService):
    """Direct Zillow scraping (existing implementation)."""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.service_name = "direct"
    
    def is_available(self) -> bool:
        return True  # Always available
    
    def scrape(
        self,
        location: str,
        limit: int = 200,
        beds_min: Optional[int] = None,
        beds_max: Optional[int] = None,
        price_min: Optional[int] = None,
        price_max: Optional[int] = None,
        verbose: bool = False,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Scrape Zillow directly using zillow_scraper.py."""
        try:
            from zillow_scraper import scrape_and_map
            
            records, blocked = scrape_and_map(
                location=location,
                limit=limit,
                beds_min=beds_min,
                beds_max=beds_max,
                price_min=price_min,
                price_max=price_max,
                min_score=0,
                fetch_details=True,
                verbose=verbose,
            )
            return records, blocked
            
        except ImportError as e:
            if verbose:
                print(f"  [Direct] zillow_scraper module not available: {e}")
            return [], False
        except Exception as e:
            if verbose:
                print(f"  [Direct] Error: {e}")
            return [], False


# ── Service factory ─────────────────────────────────────────────────────────────

def _create_service(service_name: str, config: Dict[str, Any]) -> ZillowScraperService:
    """Create a scraper service by name."""
    services = {
        "apify": ApifyService,
        "scrapebadger": ScrapeBadgerService,
        "oxylabs": OxylabsService,
        "direct": DirectService,
    }
    
    service_class = services.get(service_name.lower())
    if not service_class:
        raise ValueError(f"Unknown service: {service_name}. Choose from: {', '.join(services.keys())}")
    
    return service_class(config)


def get_available_services(verbose: bool = False) -> List[str]:
    """Get list of available (configured) services."""
    config = _get_config()
    available = []
    
    for service_name in _SERVICE_PRIORITY:
        service = _create_service(service_name, config)
        if service.is_available():
            available.append(service_name)
            if verbose:
                print(f"  [zillow_services] {service_name} is available")
    
    return available


# ── Main interface ──────────────────────────────────────────────────────────────

def scrape_zillow_with_service(
    location: str,
    service: str = "auto",
    limit: int = 200,
    beds_min: Optional[int] = None,
    beds_max: Optional[int] = None,
    price_min: Optional[int] = None,
    price_max: Optional[int] = None,
    verbose: bool = False,
) -> Tuple[List[Dict[str, Any]], bool, str]:
    """
    Scrape Zillow listings using the specified service or auto-select.
    
    Args:
        location: Location string (e.g., "Dallas, TX")
        service: Service name ("auto", "direct", "apify", "scrapebadger", "oxylabs")
        limit: Max listings to return
        beds_min/max: Bedroom filters
        price_min/max: Price filters
        verbose: Print progress
    
    Returns:
        (records, blocked, service_used)
        - records: List of pipeline_properties-compatible dicts
        - blocked: True if bot detection triggered
        - service_used: Name of the service that was used
    """
    config = _get_config()
    
    if service == "auto":
        # Try services in priority order
        available = get_available_services(verbose=verbose)
        
        if not available:
            if verbose:
                print("  [zillow_services] No services configured, falling back to direct")
            service = "direct"
        else:
            # Use first available service
            service = available[0]
            if verbose:
                print(f"  [zillow_services] Auto-selected service: {service}")
    
    # Create and use the selected service
    scraper_service = _create_service(service, config)
    
    if verbose:
        print(f"  [zillow_services] Using {service} service for {location}")
    
    records, blocked = scraper_service.scrape(
        location=location,
        limit=limit,
        beds_min=beds_min,
        beds_max=beds_max,
        price_min=price_min,
        price_max=price_max,
        verbose=verbose,
    )
    
    if verbose:
        print(f"  [zillow_services] {service} returned {len(records)} records (blocked={blocked})")
    
    return records, blocked, service


# ── CLI entry point for testing ────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test Zillow scraping services")
    parser.add_argument("location", help="Location to scrape (e.g., 'Dallas, TX')")
    parser.add_argument("--service", default="auto", choices=["auto", "direct", "apify", "scrapebadger", "oxylabs"])
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    
    print(f"Testing Zillow scraping: {args.location}")
    print(f"Service: {args.service}")
    print()
    
    records, blocked, used = scrape_zillow_with_service(
        location=args.location,
        service=args.service,
        limit=args.limit,
        verbose=args.verbose,
    )
    
    print(f"\nResults:")
    print(f"  Service used: {used}")
    print(f"  Records: {len(records)}")
    print(f"  Blocked: {blocked}")
    
    if records:
        print(f"\nFirst record:")
        r = records[0]
        print(f"  Address: {r.get('address')}, {r.get('city')}")
        print(f"  Price: ${r.get('monthly_rent')}/mo")
        print(f"  Beds: {r.get('bedrooms')}")
        print(f"  Score: {r.get('data_quality_score')}")
        print(f"  Photos: {len(json.loads(r.get('original_image_urls') or '[]'))}")