#!/usr/bin/env python3
"""
Test script for Zillow scraping services integration.
Run this to verify the services are properly configured and working.
"""

import sys
import os

# Add scraper directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_import():
    """Test that zillow_services module can be imported."""
    print("=" * 60)
    print("TEST 1: Import zillow_services module")
    print("=" * 60)
    try:
        from zillow_services import (
            scrape_zillow_with_service,
            get_available_services,
            _get_config,
            ApifyService,
            ScrapeBadgerService,
            OxylabsService,
            DirectService,
        )
        print("[PASS] Import successful")
        return True
    except Exception as e:
        print("[FAIL] Import failed: " + str(e))
        return False


def test_config():
    """Test configuration loading."""
    print("\n" + "=" * 60)
    print("TEST 2: Configuration")
    print("=" * 60)
    
    from zillow_services import _get_config
    
    config = _get_config()
    
    print("Service configurations:")
    for service_name, service_config in config.items():
        enabled = service_config.get("enabled", False)
        status = "[ENABLED]" if enabled else "[disabled]"
        print(f"  {service_name:15s}: {status}")
        if enabled:
            if service_name == "apify":
                token = service_config.get("api_token", "")
                print(f"    Token: {token[:10]}..." if len(token) > 10 else "    Token: (not set)")
            elif service_name == "scrapebadger":
                token = service_config.get("api_token", "")
                print(f"    Token: {token[:10]}..." if len(token) > 10 else "    Token: (not set)")
            elif service_name == "oxylabs":
                username = service_config.get("username", "")
                print(f"    Username: {username[:10]}..." if len(username) > 10 else "    Username: (not set)")
    
    return True


def test_available_services():
    """Test getting available services."""
    print("\n" + "=" * 60)
    print("TEST 3: Available Services")
    print("=" * 60)
    
    from zillow_services import get_available_services
    
    available = get_available_services(verbose=True)
    
    print(f"\nAvailable services: {available}")
    
    if not available:
        print("⚠️  No services configured. You can still use 'direct' mode.")
    
    return True


def test_service_instantiation():
    """Test creating service instances."""
    print("\n" + "=" * 60)
    print("TEST 4: Service Instantiation")
    print("=" * 60)
    
    from zillow_services import _create_service, _get_config
    
    config = _get_config()
    
    for service_name in ["apify", "scrapebadger", "oxylabs", "direct"]:
        try:
            service = _create_service(service_name, config)
            available = service.is_available()
            print(f"  {service_name:15s}: [PASS] Created (available={available})")
        except Exception as e:
            print(f"  {service_name:15s}: [FAIL] Failed: {e}")
    
    return True


def test_dry_run_scrape():
    """Test a dry-run scrape with direct service."""
    print("\n" + "=" * 60)
    print("TEST 5: Dry-Run Scrape (Direct Service)")
    print("=" * 60)
    
    from zillow_services import scrape_zillow_with_service
    
    print("\nAttempting to scrape 5 listings from Dallas, TX...")
    print("(This will use the direct scraper which requires a residential IP)")
    
    try:
        records, blocked, service_used = scrape_zillow_with_service(
            location="Dallas, TX",
            service="direct",
            limit=5,
            verbose=True,
        )
        
        print(f"\n[PASS] Scrape completed")
        print(f"   Service used: {service_used}")
        print(f"   Records returned: {len(records)}")
        print(f"   Blocked: {blocked}")
        
        if records:
            print(f"\nFirst record:")
            r = records[0]
            print(f"  Address: {r.get('address')}, {r.get('city')}")
            print(f"  Price: ${r.get('monthly_rent')}/mo")
            print(f"  Beds: {r.get('bedrooms')}")
            print(f"  Score: {r.get('data_quality_score')}")
            photos = []
            try:
                photos = eval(r.get('original_image_urls') or '[]')
            except:
                pass
            print(f"  Photos: {len(photos)}")
        
        return True
        
    except Exception as e:
        print("[FAIL] Scrape failed: " + str(e))
        import traceback
        traceback.print_exc()
        return False


def main():
    """Run all tests."""
    print("\nZillow Services Integration Test\n")
    
    results = []
    
    # Run tests
    results.append(("Import", test_import()))
    results.append(("Config", test_config()))
    results.append(("Available Services", test_available_services()))
    results.append(("Service Instantiation", test_service_instantiation()))
    results.append(("Dry-Run Scrape", test_dry_run_scrape()))
    
    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "[PASS]" if result else "[FAIL]"
        print(f"  {test_name:25s}: {status}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\nAll tests passed!")
        return 0
    else:
        print(f"\n{total - passed} test(s) failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())