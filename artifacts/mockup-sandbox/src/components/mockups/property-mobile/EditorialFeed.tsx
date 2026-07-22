import React from 'react';
import { ArrowLeft, Heart, Share2, MapPin, Check, Home, Zap, Droplet, Car, Wind, PawPrint, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function EditorialFeed() {
  return (
    <div className="min-h-screen bg-[#faf9f7] text-[#1a1008] pb-24">
      {/* Top Navigation Bar */}
      <div className="sticky top-0 z-50 bg-[#fefdf9]/95 backdrop-blur-sm border-b border-[#e8e2d8]">
        <div className="flex items-center justify-between px-4 py-3">
          <button className="flex items-center gap-2 text-sm text-[#4a453c]">
            <ArrowLeft className="w-5 h-5" />
            <span>Back to listings</span>
          </button>
          <div className="flex items-center gap-3">
            <button className="p-2 hover:bg-[#f0ebe3] rounded-full transition-colors">
              <Heart className="w-5 h-5 text-[#4a453c]" />
            </button>
            <button className="p-2 hover:bg-[#f0ebe3] rounded-full transition-colors">
              <Share2 className="w-5 h-5 text-[#4a453c]" />
            </button>
          </div>
        </div>
      </div>

      {/* Photo Gallery - Horizontal Scroll */}
      <div className="overflow-x-auto scrollbar-hide px-4 py-5">
        <div className="flex gap-3" style={{ scrollSnapType: 'x mandatory' }}>
          <div 
            className="flex-shrink-0 rounded-2xl overflow-hidden shadow-sm"
            style={{ width: '75vw', maxWidth: '320px', height: '200px', scrollSnapAlign: 'start' }}
          >
            <img 
              src="/__mockup/images/maple-exterior.jpg" 
              alt="The Maple exterior"
              className="w-full h-full object-cover"
            />
          </div>
          <div 
            className="flex-shrink-0 rounded-2xl overflow-hidden shadow-sm"
            style={{ width: '75vw', maxWidth: '320px', height: '200px', scrollSnapAlign: 'start' }}
          >
            <img 
              src="/__mockup/images/maple-kitchen.jpg" 
              alt="Kitchen"
              className="w-full h-full object-cover"
            />
          </div>
          <div 
            className="flex-shrink-0 rounded-2xl overflow-hidden shadow-sm"
            style={{ width: '75vw', maxWidth: '320px', height: '200px', scrollSnapAlign: 'start' }}
          >
            <img 
              src="/__mockup/images/maple-living.jpg" 
              alt="Living room"
              className="w-full h-full object-cover"
            />
          </div>
        </div>
      </div>

      {/* Property Header */}
      <div className="px-5 pt-2 pb-6">
        <h1 className="text-4xl font-serif italic text-[#1a1008] mb-2" style={{ fontFamily: 'Fraunces, serif' }}>
          The Maple
        </h1>
        <p className="text-sm text-[#6b5f4f]">412 Birchwood Ave, Santa Rosa, CA 95401</p>
      </div>

      {/* Price & Stats */}
      <div className="px-5 pb-6">
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-5xl font-bold text-[#1a1008]">$2,850</span>
          <span className="text-xl text-[#6b5f4f]">/month</span>
        </div>
        <div className="flex items-center gap-2 text-[#4a453c] text-base">
          <span className="font-medium">3 bed</span>
          <span>·</span>
          <span className="font-medium">2 bath</span>
          <span>·</span>
          <span className="font-medium">1,340 sf</span>
        </div>
      </div>

      {/* Availability & CTA */}
      <div className="px-5 pb-8">
        <div className="flex items-center gap-3 mb-4">
          <Badge className="bg-[#e8f4e8] text-[#2d5a2d] hover:bg-[#e8f4e8] border-0 px-3 py-1.5 text-sm font-medium">
            Available August 1, 2026
          </Badge>
        </div>
        <Button 
          className="w-full bg-[#1a2744] hover:bg-[#0f1a2e] text-white h-12 text-base font-semibold rounded-xl shadow-lg"
        >
          Apply Now
        </Button>
      </div>

      {/* Divider */}
      <div className="border-t border-[#e8e2d8] mx-5 mb-8"></div>

      {/* About Section */}
      <div className="px-5 pb-8">
        <h2 className="text-2xl font-serif italic mb-4 text-[#1a1008]" style={{ fontFamily: 'Fraunces, serif' }}>
          About this home
        </h2>
        <p className="text-[#4a453c] leading-relaxed text-base">
          Bright craftsman home with updated kitchen, hardwood floors, and a private backyard. 
          Natural light throughout. Quiet street walking distance to downtown Santa Rosa.
        </p>
      </div>

      {/* Divider */}
      <div className="border-t border-[#e8e2d8] mx-5 mb-8"></div>

      {/* Amenities Section */}
      <div className="px-5 pb-8">
        <h2 className="text-2xl font-serif italic mb-5 text-[#1a1008]" style={{ fontFamily: 'Fraunces, serif' }}>
          What's included
        </h2>
        <div className="flex flex-wrap gap-2.5">
          <div className="flex items-center gap-2 bg-[#f0ebe3] px-4 py-2.5 rounded-full">
            <Wind className="w-4 h-4 text-[#6b5f4f]" />
            <span className="text-sm text-[#1a1008]">Central AC</span>
          </div>
          <div className="flex items-center gap-2 bg-[#f0ebe3] px-4 py-2.5 rounded-full">
            <Zap className="w-4 h-4 text-[#6b5f4f]" />
            <span className="text-sm text-[#1a1008]">Dishwasher</span>
          </div>
          <div className="flex items-center gap-2 bg-[#f0ebe3] px-4 py-2.5 rounded-full">
            <Droplet className="w-4 h-4 text-[#6b5f4f]" />
            <span className="text-sm text-[#1a1008]">In-unit W/D</span>
          </div>
          <div className="flex items-center gap-2 bg-[#f0ebe3] px-4 py-2.5 rounded-full">
            <Home className="w-4 h-4 text-[#6b5f4f]" />
            <span className="text-sm text-[#1a1008]">Private Backyard</span>
          </div>
          <div className="flex items-center gap-2 bg-[#f0ebe3] px-4 py-2.5 rounded-full">
            <Car className="w-4 h-4 text-[#6b5f4f]" />
            <span className="text-sm text-[#1a1008]">Covered Parking</span>
          </div>
          <div className="flex items-center gap-2 bg-[#f0ebe3] px-4 py-2.5 rounded-full">
            <Home className="w-4 h-4 text-[#6b5f4f]" />
            <span className="text-sm text-[#1a1008]">Hardwood Floors</span>
          </div>
        </div>
        
        {/* Additional Info Chips */}
        <div className="flex flex-wrap gap-2.5 mt-4 pt-4 border-t border-[#e8e2d8]">
          <div className="flex items-center gap-2 px-3 py-2 bg-[#fef5f5] rounded-lg">
            <PawPrint className="w-4 h-4 text-[#8b5a5a]" />
            <span className="text-sm text-[#4a453c]">No pets</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 bg-[#f5f9fe] rounded-lg">
            <Car className="w-4 h-4 text-[#5a6b8b]" />
            <span className="text-sm text-[#4a453c]">Parking included</span>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-[#e8e2d8] mx-5 mb-8"></div>

      {/* Cost Breakdown Section */}
      <div className="px-5 pb-8">
        <h2 className="text-2xl font-serif italic mb-5 text-[#1a1008]" style={{ fontFamily: 'Fraunces, serif' }}>
          What you'll pay
        </h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <span className="text-[#4a453c]">Monthly rent</span>
            <span className="font-semibold text-[#1a1008] text-lg">$2,850</span>
          </div>
          <div className="flex items-center justify-between py-3 border-t border-[#e8e2d8]">
            <span className="text-[#4a453c]">Security deposit</span>
            <span className="font-semibold text-[#1a1008] text-lg">$2,850</span>
          </div>
          <div className="flex items-center justify-between py-3 border-t border-[#e8e2d8]">
            <span className="text-[#4a453c]">Application fee</span>
            <span className="font-semibold text-[#1a1008] text-lg">$50</span>
          </div>
          <div className="pt-3 border-t border-[#e8e2d8]">
            <p className="text-sm text-[#6b5f4f] leading-relaxed">
              Tenant pays: Electricity, Gas, Internet
            </p>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-[#e8e2d8] mx-5 mb-8"></div>

      {/* Location Section */}
      <div className="px-5 pb-8">
        <h2 className="text-2xl font-serif italic mb-5 text-[#1a1008]" style={{ fontFamily: 'Fraunces, serif' }}>
          Where you'll live
        </h2>
        <div className="bg-gradient-to-br from-[#f0ebe3] to-[#e8dfd0] rounded-2xl p-8 flex flex-col items-center justify-center h-48 shadow-sm">
          <MapPin className="w-12 h-12 text-[#8b7355] mb-3" />
          <p className="text-[#4a453c] font-medium text-center">412 Birchwood Ave</p>
          <p className="text-sm text-[#6b5f4f] text-center mt-1">Downtown Santa Rosa</p>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-[#e8e2d8] mx-5 mb-8"></div>

      {/* Application Process */}
      <div className="px-5 pb-8">
        <h2 className="text-2xl font-serif italic mb-5 text-[#1a1008]" style={{ fontFamily: 'Fraunces, serif' }}>
          Before you apply
        </h2>
        <div className="flex items-start gap-4 overflow-x-auto pb-2">
          <div className="flex-1 min-w-[100px]">
            <div className="w-10 h-10 rounded-full bg-[#1a2744] text-white flex items-center justify-center font-bold mb-3 text-lg">
              1
            </div>
            <h3 className="font-semibold text-[#1a1008] mb-1.5 text-sm">Apply</h3>
            <p className="text-xs text-[#6b5f4f] leading-relaxed">Submit your application with ID and proof of income</p>
          </div>
          <div className="flex-1 min-w-[100px]">
            <div className="w-10 h-10 rounded-full bg-[#1a2744] text-white flex items-center justify-center font-bold mb-3 text-lg">
              2
            </div>
            <h3 className="font-semibold text-[#1a1008] mb-1.5 text-sm">Review</h3>
            <p className="text-xs text-[#6b5f4f] leading-relaxed">We'll review and get back to you within 2 business days</p>
          </div>
          <div className="flex-1 min-w-[100px]">
            <div className="w-10 h-10 rounded-full bg-[#1a2744] text-white flex items-center justify-center font-bold mb-3 text-lg">
              3
            </div>
            <h3 className="font-semibold text-[#1a1008] mb-1.5 text-sm">Move In</h3>
            <p className="text-xs text-[#6b5f4f] leading-relaxed">Sign lease and schedule your move-in date</p>
          </div>
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-[#fefdf9] border-t border-[#e8e2d8] px-5 py-4 shadow-2xl z-50">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#6b5f4f]">Monthly rent</p>
            <p className="text-2xl font-serif font-bold text-[#1a1008]" style={{ fontFamily: 'Fraunces, serif' }}>
              $2,850
            </p>
          </div>
          <Button 
            className="bg-[#1a2744] hover:bg-[#0f1a2e] text-white px-8 h-12 text-base font-semibold rounded-xl shadow-lg"
          >
            Apply Now
          </Button>
        </div>
      </div>

      {/* Hidden style tag for scrollbar hide and custom font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;1,400;1,700&family=Inter:wght@400;500;600;700&display=swap');
        
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
}
