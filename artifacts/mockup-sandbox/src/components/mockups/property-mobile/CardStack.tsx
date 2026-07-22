import React from 'react';
import { ArrowLeft, Heart, Share2, Bed, Bath, Maximize2, MapPin, Check, ChevronRight } from 'lucide-react';

export function CardStack() {
  return (
    <div className="min-h-screen bg-[#f1f5f9] pb-24">
      {/* Header Navigation */}
      <div className="sticky top-0 z-50 bg-white border-b border-[#e4e8ef] px-4 py-3">
        <div className="flex items-center justify-between">
          <button className="flex items-center gap-2 text-[#0a1729] font-medium">
            <ArrowLeft className="w-5 h-5" />
            <span className="text-sm">Back to listings</span>
          </button>
          <div className="flex items-center gap-3">
            <button className="p-2 hover:bg-[#f8fafc] rounded-full transition-colors">
              <Heart className="w-5 h-5 text-[#6b7280]" />
            </button>
            <button className="p-2 hover:bg-[#f8fafc] rounded-full transition-colors">
              <Share2 className="w-5 h-5 text-[#6b7280]" />
            </button>
          </div>
        </div>
      </div>

      {/* Photo Gallery Card */}
      <div className="px-4 pt-4">
        <div className="relative rounded-2xl overflow-hidden shadow-sm bg-gradient-to-br from-[#7dd3fc] via-[#38bdf8] to-[#0ea5e9]" style={{ aspectRatio: '16/9' }}>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-white/90">
              <div className="text-6xl mb-2">🏡</div>
              <div className="text-sm font-medium">The Maple</div>
            </div>
          </div>
          <div className="absolute top-3 right-3 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm">
            <span className="text-xs font-medium text-[#0a1729]">📸 8 photos</span>
          </div>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-white' : 'bg-white/40'}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Price & Title Card */}
      <div className="px-4 pt-4">
        <div className="bg-white rounded-2xl shadow-sm p-5 border border-[#e4e8ef]">
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-3xl font-bold text-[#0a1729]">$2,850<span className="text-lg font-normal text-[#6b7280]">/mo</span></div>
            <div className="inline-flex items-center gap-1.5 bg-[#dcfce7] text-[#166534] px-3 py-1 rounded-full text-xs font-medium">
              <div className="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
              Available Aug 1
            </div>
          </div>
          <h1 className="text-xl font-bold text-[#0a1729] mb-1">The Maple</h1>
          <p className="text-sm text-[#6b7280] mb-4">412 Birchwood Ave, Santa Rosa, CA 95401</p>
          
          {/* Stats Pills */}
          <div className="flex gap-2 mb-4">
            <div className="flex items-center gap-2 bg-[#f8fafc] border border-[#e4e8ef] px-3 py-2 rounded-xl flex-1">
              <Bed className="w-4 h-4 text-[#006aff]" />
              <span className="text-sm font-medium text-[#0a1729]">3 bed</span>
            </div>
            <div className="flex items-center gap-2 bg-[#f8fafc] border border-[#e4e8ef] px-3 py-2 rounded-xl flex-1">
              <Bath className="w-4 h-4 text-[#006aff]" />
              <span className="text-sm font-medium text-[#0a1729]">2 bath</span>
            </div>
            <div className="flex items-center gap-2 bg-[#f8fafc] border border-[#e4e8ef] px-3 py-2 rounded-xl flex-1">
              <Maximize2 className="w-4 h-4 text-[#006aff]" />
              <span className="text-sm font-medium text-[#0a1729]">1,340 sqft</span>
            </div>
          </div>

          {/* Apply Button */}
          <button className="w-full bg-[#006aff] hover:bg-[#0056d6] text-white font-semibold py-3.5 rounded-xl transition-colors shadow-sm">
            Apply Now
          </button>
        </div>
      </div>

      {/* About Card */}
      <div className="px-4 pt-4">
        <div className="bg-white rounded-2xl shadow-sm p-5 border border-[#e4e8ef]">
          <h2 className="text-base font-bold text-[#0a1729] mb-3 flex items-center gap-2">
            About this home
          </h2>
          <p className="text-[#0a1729] text-sm leading-relaxed">
            Bright craftsman home with updated kitchen, hardwood floors, and a private backyard. Natural light throughout. Quiet street walking distance to downtown Santa Rosa.
          </p>
          <div className="mt-4 pt-4 border-t border-[#e4e8ef] grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[#6b7280] mb-1">Pets</div>
              <div className="text-[#0a1729] font-medium">No</div>
            </div>
            <div>
              <div className="text-[#6b7280] mb-1">Parking</div>
              <div className="text-[#0a1729] font-medium">Included</div>
            </div>
            <div>
              <div className="text-[#6b7280] mb-1">Laundry</div>
              <div className="text-[#0a1729] font-medium">In-unit</div>
            </div>
          </div>
        </div>
      </div>

      {/* Features Card */}
      <div className="px-4 pt-4">
        <div className="bg-white rounded-2xl shadow-sm p-5 border border-[#e4e8ef]">
          <h2 className="text-base font-bold text-[#0a1729] mb-4">Features & Amenities</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              'Central AC',
              'Dishwasher',
              'In-unit W/D',
              'Private Backyard',
              'Covered Parking',
              'Hardwood Floors'
            ].map((amenity) => (
              <div key={amenity} className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-[#dcfce7] flex items-center justify-center flex-shrink-0">
                  <Check className="w-3 h-3 text-[#166534]" />
                </div>
                <span className="text-sm text-[#0a1729]">{amenity}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Costs Card */}
      <div className="px-4 pt-4">
        <div className="bg-white rounded-2xl shadow-sm p-5 border border-[#e4e8ef]">
          <h2 className="text-base font-bold text-[#0a1729] mb-4">Cost Breakdown</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#6b7280]">Monthly rent</span>
              <span className="text-sm font-semibold text-[#0a1729]">$2,850</span>
            </div>
            <div className="border-t border-dashed border-[#e4e8ef]"></div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#6b7280]">Security deposit</span>
              <span className="text-sm font-semibold text-[#0a1729]">$2,850</span>
            </div>
            <div className="border-t border-dashed border-[#e4e8ef]"></div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#6b7280]">Application fee</span>
              <span className="text-sm font-semibold text-[#0a1729]">$50</span>
            </div>
            <div className="border-t border-[#e4e8ef] pt-3 mt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#0a1729]">Due at move-in</span>
                <span className="text-lg font-bold text-[#0a1729]">$5,700</span>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-[#e4e8ef]">
            <div className="text-xs text-[#6b7280] font-medium mb-2">Tenant pays utilities:</div>
            <div className="flex flex-wrap gap-2">
              {['Electricity', 'Gas', 'Internet'].map((util) => (
                <span key={util} className="text-xs bg-[#f8fafc] border border-[#e4e8ef] px-2.5 py-1 rounded-md text-[#0a1729]">
                  {util}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Location Card */}
      <div className="px-4 pt-4">
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden border border-[#e4e8ef]">
          <div className="p-5 pb-4">
            <h2 className="text-base font-bold text-[#0a1729] mb-1">Location</h2>
            <p className="text-sm text-[#6b7280]">Downtown Santa Rosa</p>
          </div>
          <div className="relative bg-gradient-to-br from-[#cbd5e1] to-[#94a3b8] h-40 flex items-center justify-center">
            <MapPin className="w-8 h-8 text-white" />
            <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-lg shadow-sm">
              <div className="text-xs font-medium text-[#0a1729]">412 Birchwood Ave</div>
            </div>
          </div>
        </div>
      </div>

      {/* Process Card */}
      <div className="px-4 pt-4">
        <div className="bg-white rounded-2xl shadow-sm p-5 border border-[#e4e8ef]">
          <h2 className="text-base font-bold text-[#0a1729] mb-4">Before You Apply</h2>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-[#006aff] text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
                1
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-[#0a1729] mb-0.5">Submit Application</div>
                <div className="text-xs text-[#6b7280]">Complete online form with basic info</div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-[#e4e8ef] text-[#6b7280] flex items-center justify-center text-xs font-bold flex-shrink-0">
                2
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-[#0a1729] mb-0.5">Background & Credit Check</div>
                <div className="text-xs text-[#6b7280]">Reviewed within 48 hours</div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-[#e4e8ef] text-[#6b7280] flex items-center justify-center text-xs font-bold flex-shrink-0">
                3
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-[#0a1729] mb-0.5">Sign Lease & Move In</div>
                <div className="text-xs text-[#6b7280]">Digital signing, schedule move-in</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-[#e4e8ef] px-4 py-3 shadow-lg z-50">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-[#6b7280] mb-0.5">Monthly rent</div>
            <div className="text-xl font-bold text-[#0a1729]">$2,850</div>
          </div>
          <button className="bg-[#006aff] hover:bg-[#0056d6] text-white font-semibold px-8 py-3 rounded-xl transition-colors shadow-sm flex items-center gap-2">
            Apply Now
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default CardStack;
