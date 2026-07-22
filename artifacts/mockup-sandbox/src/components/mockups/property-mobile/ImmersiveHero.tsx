import React from 'react';
import { ArrowLeft, Heart, Share2, Bed, Bath, Maximize2, MapPin, Check, Calendar, DollarSign, FileText, Key } from 'lucide-react';

export default function ImmersiveHero() {
  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Full-Bleed Hero Image */}
      <div className="relative h-[55vh] overflow-hidden">
        {/* Gradient Placeholder Image */}
        <div className="absolute inset-0 bg-gradient-to-br from-amber-100 via-slate-50 to-amber-50 flex items-center justify-center">
          <svg 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1.5"
            className="w-32 h-32 text-amber-300/40"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        
        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/70" />
        
        {/* Top navigation */}
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between p-4 z-10">
          <button className="w-10 h-10 rounded-full bg-white/95 backdrop-blur-sm flex items-center justify-center shadow-lg">
            <ArrowLeft className="w-5 h-5 text-gray-900" />
          </button>
          <div className="flex gap-2">
            <button className="w-10 h-10 rounded-full bg-white/95 backdrop-blur-sm flex items-center justify-center shadow-lg">
              <Heart className="w-5 h-5 text-gray-900" />
            </button>
            <button className="w-10 h-10 rounded-full bg-white/95 backdrop-blur-sm flex items-center justify-center shadow-lg">
              <Share2 className="w-5 h-5 text-gray-900" />
            </button>
          </div>
        </div>
        
        {/* Property info overlay on hero */}
        <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
          <h1 className="text-white text-3xl font-bold mb-1" style={{ fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>
            The Maple
          </h1>
          <div className="flex items-baseline gap-3 mb-4">
            <span className="text-white text-4xl font-bold tracking-tight">$2,850</span>
            <span className="text-white/80 text-lg">/mo</span>
          </div>
          <div className="flex gap-4 text-white/90">
            <div className="flex items-center gap-1.5">
              <Bed className="w-5 h-5" />
              <span className="font-medium">3 beds</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Bath className="w-5 h-5" />
              <span className="font-medium">2 baths</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Maximize2 className="w-5 h-5" />
              <span className="font-medium">1,340 sqft</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="pb-24">
        {/* Address */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-start gap-2">
            <MapPin className="w-5 h-5 text-[#006aff] mt-0.5 flex-shrink-0" />
            <p className="text-[#0a1729] text-lg leading-snug">
              412 Birchwood Ave, Santa Rosa, CA 95401
            </p>
          </div>
        </div>

        {/* Availability + CTA */}
        <div className="px-6 pb-8 space-y-3">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 rounded-full">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-emerald-700 font-medium text-sm">Available August 1, 2026</span>
          </div>
          <button className="w-full bg-[#006aff] text-white font-semibold py-4 rounded-xl text-lg shadow-lg shadow-blue-500/20 active:scale-[0.98] transition-transform">
            Apply Now
          </button>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#e4e8ef] mx-6" />

        {/* About Section */}
        <div className="px-6 py-8">
          <h2 className="text-2xl mb-4 text-[#0a1729]" style={{ fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>
            About this home
          </h2>
          <p className="text-[#6b7280] text-base leading-relaxed">
            Bright craftsman home with updated kitchen, hardwood floors, and a private backyard. Natural light throughout. Quiet street walking distance to downtown Santa Rosa.
          </p>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#e4e8ef] mx-6" />

        {/* Amenities */}
        <div className="px-6 py-8">
          <h2 className="text-2xl mb-6 text-[#0a1729]" style={{ fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>
            Amenities
          </h2>
          <div className="grid grid-cols-3 gap-6">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#006aff]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
              </div>
              <span className="text-sm text-[#0a1729] font-medium leading-tight">Central AC</span>
            </div>
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#006aff]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M3 12h18M3 18h18" />
                </svg>
              </div>
              <span className="text-sm text-[#0a1729] font-medium leading-tight">Dishwasher</span>
            </div>
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#006aff]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v6m0 6v6m8.66-9l-5.2 3m-6.92 4l-5.2 3m0-12l5.2 3m6.92 4l5.2 3" />
                </svg>
              </div>
              <span className="text-sm text-[#0a1729] font-medium leading-tight">In-unit W/D</span>
            </div>
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#006aff]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
              </div>
              <span className="text-sm text-[#0a1729] font-medium leading-tight">Private Backyard</span>
            </div>
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#006aff]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              </div>
              <span className="text-sm text-[#0a1729] font-medium leading-tight">Covered Parking</span>
            </div>
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#006aff]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
              </div>
              <span className="text-sm text-[#0a1729] font-medium leading-tight">Hardwood Floors</span>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#e4e8ef] mx-6" />

        {/* Cost Breakdown */}
        <div className="px-6 py-8">
          <h2 className="text-2xl mb-6 text-[#0a1729]" style={{ fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>
            Cost breakdown
          </h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-[#6b7280]">Monthly rent</span>
              <span className="text-[#0a1729] font-semibold text-lg">$2,850</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[#6b7280]">Security deposit</span>
              <span className="text-[#0a1729] font-semibold text-lg">$2,850</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[#6b7280]">Application fee</span>
              <span className="text-[#0a1729] font-semibold text-lg">$50</span>
            </div>
            <div className="pt-2 border-t border-[#e4e8ef]">
              <p className="text-sm text-[#6b7280]">
                Tenant pays: Electricity • Gas • Internet
              </p>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#e4e8ef] mx-6" />

        {/* Location Map */}
        <div className="px-6 py-8">
          <h2 className="text-2xl mb-6 text-[#0a1729]" style={{ fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>
            Location
          </h2>
          <div className="relative h-48 bg-gradient-to-br from-blue-50 to-slate-100 rounded-2xl overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <MapPin className="w-12 h-12 text-[#006aff] mx-auto mb-2" />
                <p className="text-[#0a1729] font-semibold">Downtown Santa Rosa</p>
                <p className="text-[#6b7280] text-sm">Walk Score: 78</p>
              </div>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#e4e8ef] mx-6" />

        {/* Before You Apply */}
        <div className="px-6 py-8">
          <h2 className="text-2xl mb-6 text-[#0a1729]" style={{ fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>
            Before you apply
          </h2>
          <div className="space-y-6">
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#006aff] text-white flex items-center justify-center font-bold">
                1
              </div>
              <div>
                <h3 className="text-[#0a1729] font-semibold mb-1">Apply Online</h3>
                <p className="text-[#6b7280] text-sm leading-relaxed">
                  Complete your application and pay the $50 fee. Takes about 10 minutes.
                </p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#006aff] text-white flex items-center justify-center font-bold">
                2
              </div>
              <div>
                <h3 className="text-[#0a1729] font-semibold mb-1">Review & Approval</h3>
                <p className="text-[#6b7280] text-sm leading-relaxed">
                  We review applications within 24-48 hours and run background + credit checks.
                </p>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#006aff] text-white flex items-center justify-center font-bold">
                3
              </div>
              <div>
                <h3 className="text-[#0a1729] font-semibold mb-1">Move In</h3>
                <p className="text-[#6b7280] text-sm leading-relaxed">
                  Sign your lease, pay first month + deposit, and get your keys!
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-[#e4e8ef] px-6 py-4 flex items-center justify-between shadow-lg z-20">
        <div>
          <p className="text-[#6b7280] text-xs">Monthly rent</p>
          <p className="text-[#0a1729] text-2xl font-bold tracking-tight">$2,850</p>
        </div>
        <button className="bg-[#006aff] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-500/20 active:scale-[0.98] transition-transform">
          Apply Now
        </button>
      </div>
    </div>
  );
}
