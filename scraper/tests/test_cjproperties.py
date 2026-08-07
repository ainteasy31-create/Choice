from scraper.cjproperties_scraper import _extract_image_urls_from_detail_html


def test_extracts_multiple_gallery_urls_from_detail_html():
    html = """
    <html><body>
      <script>
        window.__INITIAL_STATE__ = {
          "photos": [
            "https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=abc123",
            "https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=def456"
          ]
        };
      </script>
      <img src="https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=ghi789">
      <a href="https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=abc123">dup</a>
    </body></html>
    """

    urls = _extract_image_urls_from_detail_html(html)

    assert urls == [
        "https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=abc123",
        "https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=def456",
        "https://rm12filereader.rentmanager.com/files/get/?EID=cjre&FKey=ghi789",
    ]
