import mongoose, { Document, Schema, Model } from "mongoose";

const ReviewSchema = new Schema({
    author_name: { type: String }, 
    rating: { type: Number }, 
    text: { type: String }, 
    time: { type: Number }, // Optional: Include review timestamp if available from Google
}, { _id: false });

export const GoogleDetailsSchema = new Schema({
    // Core Place Data
    placeId: { type: String, index: true }, 
    googleName: { type: String },
    rating: { type: Number },
    lat: { type: Number },
    lng: { type: Number },
    
    // Multiple Photos (References only, URLs generated in controller)
    photoReferences: [{ type: String }], 
    
    // Reviews
    reviews: [ReviewSchema], 
    
    // Cache Management
    lastUpdated: { type: Date, default: Date.now, expires: '30d' }, // Data expires 30 days after creation
}, { _id: false });


// Define the TypeScript Interface for the Document Fields
export interface INursingFacility extends Document {
  cms_certification_number_ccn: string;
  provider_name: string | null;
  provider_address: string | null;
  city_town: string | null;
  state: string | null;
  zip_code: string | null;
  telephone_number: string | null;
  provider_ssa_county_code: string | null;
  county_parish: string | null;
  ownership_type: string | null;
  number_of_certified_beds: number | null;
  average_number_of_residents_per_day: number | null;
  average_number_of_residents_per_day_footnote: string | null;
  provider_type: string | null;
  provider_resides_in_hospital: string | null;
  legal_business_name: string | null;
  date_first_approved_to_provide_medicare_and_medicaid_services: Date | null;
  chain_name: string | null;
  chain_id: string | null;
  number_of_facilities_in_chain: number | null;
  chain_average_overall_5_star_rating: string | null;
  chain_average_health_inspection_rating: string | null;
  chain_average_staffing_rating: string | null;
  chain_average_qm_rating: string | null;
  continuing_care_retirement_community: string | null;
  special_focus_status: string | null;
  abuse_icon: string | null;
  most_recent_health_inspection_more_than_2_years_ago: string | null;
  provider_changed_ownership_in_last_12_months: string | null;
  with_a_resident_and_family_council: string | null;
  automatic_sprinkler_systems_in_all_required_areas: string | null;
  overall_rating: string | null;
  overall_rating_footnote: string | null;
  health_inspection_rating: string | null;
  health_inspection_rating_footnote: string | null;
  qm_rating: string | null;
  qm_rating_footnote: string | null;
  long_stay_qm_rating: string | null;
  long_stay_qm_rating_footnote: string | null;
  short_stay_qm_rating: string | null;
  short_stay_qm_rating_footnote: string | null;
  staffing_rating: string | null;
  staffing_rating_footnote: string | null;
  reported_staffing_footnote: string | null;
  physical_therapist_staffing_footnote: string | null;
  reported_nurse_aide_staffing_hours_per_resident_per_day: number | null;
  reported_lpn_staffing_hours_per_resident_per_day: number | null;
  reported_rn_staffing_hours_per_resident_per_day: number | null;
  reported_licensed_staffing_hours_per_resident_per_day: number | null;
  reported_total_nurse_staffing_hours_per_resident_per_day: number | null;
  total_number_of_nurse_staff_hours_per_resident_per_day_on_the_weekend: number | null;
  registered_nurse_hours_per_resident_per_day_on_the_weekend: number | null;
  reported_physical_therapist_staffing_hours_per_resident_per_day: number | null;
  total_nursing_staff_turnover: string | null;
  total_nursing_staff_turnover_footnote: string | null;
  registered_nurse_turnover: string | null;
  registered_nurse_turnover_footnote: string | null;
  number_of_administrators_who_have_left_the_nursing_home: number | null;
  administrator_turnover_footnote: string | null;
  nursing_case_mix_index: number | null;
  nursing_case_mix_index_ratio: number | null;
  case_mix_nurse_aide_staffing_hours_per_resident_per_day: number | null;
  case_mix_lpn_staffing_hours_per_resident_per_day: number | null;
  case_mix_rn_staffing_hours_per_resident_per_day: number | null;
  case_mix_total_nurse_staffing_hours_per_resident_per_day: number | null;
  case_mix_weekend_total_nurse_staffing_hours_per_resident_per_day: number | null;
  adjusted_nurse_aide_staffing_hours_per_resident_per_day: number | null;
  adjusted_lpn_staffing_hours_per_resident_per_day: number | null;
  adjusted_rn_staffing_hours_per_resident_per_day: number | null;
  adjusted_total_nurse_staffing_hours_per_resident_per_day: number | null;
  adjusted_weekend_total_nurse_staffing_hours_per_resident_per_day: number | null;
  rating_cycle_1_standard_survey_health_date: string | null;
  rating_cycle_1_total_number_of_health_deficiencies: number | null;
  rating_cycle_1_number_of_standard_health_deficiencies: number | null;
  rating_cycle_1_number_of_complaint_health_deficiencies: number | null;
  rating_cycle_1_health_deficiency_score: number | null;
  rating_cycle_1_number_of_health_revisits: number | null;
  rating_cycle_1_health_revisit_score: number | null;
  rating_cycle_1_total_health_score: number | null;
  rating_cycle_2_standard_health_survey_date: string | null;
  rating_cycle_2_3_total_number_of_health_deficiencies: number | null;
  rating_cycle_2_number_of_standard_health_deficiencies: number | null;
  rating_cycle_2_3_number_of_complaint_health_deficiencies: number | null;
  rating_cycle_2_3_health_deficiency_score: number | null;
  rating_cycle_2_3_number_of_health_revisits: number | null;
  rating_cycle_2_3_health_revisit_score: number | null;
  rating_cycle_2_3_total_health_score: number | null;
  total_weighted_health_survey_score: number | null;
  number_of_facility_reported_incidents: number | null;
  number_of_substantiated_complaints: number | null;
  number_of_citations_from_infection_control_inspections: number | null;
  number_of_fines: number | null;
  total_amount_of_fines_in_dollars: number | null;
  number_of_payment_denials: number | null;
  total_number_of_penalties: number | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  geocoding_footnote: string | null;
  geoLocation: {
    type: string;
    coordinates: number[];
  };
  processing_date: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NursingFacilitySchema = new Schema<INursingFacility>({
  cms_certification_number_ccn: { type: String, required: true, unique: true },
  provider_name: { type: String },
  provider_address: { type: String },
  city_town: { type: String },
  state: { type: String },
  zip_code: { type: String },
  telephone_number: { type: String },
  provider_ssa_county_code: { type: String },
  county_parish: { type: String },
  ownership_type: { type: String },
  number_of_certified_beds: { type: Number },
  average_number_of_residents_per_day: { type: Number },
  average_number_of_residents_per_day_footnote: { type: String },
  provider_type: { type: String },
  provider_resides_in_hospital: { type: String },
  legal_business_name: { type: String },
  date_first_approved_to_provide_medicare_and_medicaid_services: { type: Date },
  chain_name: { type: String },
  chain_id: { type: String },
  number_of_facilities_in_chain: { type: Number },
  chain_average_overall_5_star_rating: { type: String },
  chain_average_health_inspection_rating: { type: String },
  chain_average_staffing_rating: { type: String },
  chain_average_qm_rating: { type: String },
  continuing_care_retirement_community: { type: String },
  special_focus_status: { type: String },
  abuse_icon: { type: String },
  most_recent_health_inspection_more_than_2_years_ago: { type: String },
  provider_changed_ownership_in_last_12_months: { type: String },
  with_a_resident_and_family_council: { type: String },
  automatic_sprinkler_systems_in_all_required_areas: { type: String },
  overall_rating: { type: String },
  overall_rating_footnote: { type: String },
  health_inspection_rating: { type: String },
  health_inspection_rating_footnote: { type: String },
  qm_rating: { type: String },
  qm_rating_footnote: { type: String },
  long_stay_qm_rating: { type: String },
  long_stay_qm_rating_footnote: { type: String },
  short_stay_qm_rating: { type: String },
  short_stay_qm_rating_footnote: { type: String },
  staffing_rating: { type: String },
  staffing_rating_footnote: { type: String },
  reported_staffing_footnote: { type: String },
  physical_therapist_staffing_footnote: { type: String },
  reported_nurse_aide_staffing_hours_per_resident_per_day: { type: Number },
  reported_lpn_staffing_hours_per_resident_per_day: { type: Number },
  reported_rn_staffing_hours_per_resident_per_day: { type: Number },
  reported_licensed_staffing_hours_per_resident_per_day: { type: Number },
  reported_total_nurse_staffing_hours_per_resident_per_day: { type: Number },
  total_number_of_nurse_staff_hours_per_resident_per_day_on_the_weekend: { type: Number },
  registered_nurse_hours_per_resident_per_day_on_the_weekend: { type: Number },
  reported_physical_therapist_staffing_hours_per_resident_per_day: { type: Number },
  total_nursing_staff_turnover: { type: String },
  total_nursing_staff_turnover_footnote: { type: String },
  registered_nurse_turnover: { type: String },
  registered_nurse_turnover_footnote: { type: String },
  number_of_administrators_who_have_left_the_nursing_home: { type: Number },
  administrator_turnover_footnote: { type: String },
  nursing_case_mix_index: { type: Number },
  nursing_case_mix_index_ratio: { type: Number },
  case_mix_nurse_aide_staffing_hours_per_resident_per_day: { type: Number },
  case_mix_lpn_staffing_hours_per_resident_per_day: { type: Number },
  case_mix_rn_staffing_hours_per_resident_per_day: { type: Number },
  case_mix_total_nurse_staffing_hours_per_resident_per_day: { type: Number },
  case_mix_weekend_total_nurse_staffing_hours_per_resident_per_day: { type: Number },
  adjusted_nurse_aide_staffing_hours_per_resident_per_day: { type: Number },
  adjusted_lpn_staffing_hours_per_resident_per_day: { type: Number },
  adjusted_rn_staffing_hours_per_resident_per_day: { type: Number },
  adjusted_total_nurse_staffing_hours_per_resident_per_day: { type: Number },
  adjusted_weekend_total_nurse_staffing_hours_per_resident_per_day: { type: Number },
  rating_cycle_1_standard_survey_health_date: { type: String },
  rating_cycle_1_total_number_of_health_deficiencies: { type: Number },
  rating_cycle_1_number_of_standard_health_deficiencies: { type: Number },
  rating_cycle_1_number_of_complaint_health_deficiencies: { type: Number },
  rating_cycle_1_health_deficiency_score: { type: Number },
  rating_cycle_1_number_of_health_revisits: { type: Number },
  rating_cycle_1_health_revisit_score: { type: Number },
  rating_cycle_1_total_health_score: { type: Number },
  rating_cycle_2_standard_health_survey_date: { type: String },
  rating_cycle_2_3_total_number_of_health_deficiencies: { type: Number },
  rating_cycle_2_number_of_standard_health_deficiencies: { type: Number },
  rating_cycle_2_3_number_of_complaint_health_deficiencies: { type: Number },
  rating_cycle_2_3_health_deficiency_score: { type: Number },
  rating_cycle_2_3_number_of_health_revisits: { type: Number },
  rating_cycle_2_3_health_revisit_score: { type: Number },
  rating_cycle_2_3_total_health_score: { type: Number },
  total_weighted_health_survey_score: { type: Number },
  number_of_facility_reported_incidents: { type: Number },
  number_of_substantiated_complaints: { type: Number },
  number_of_citations_from_infection_control_inspections: { type: Number },
  number_of_fines: { type: Number },
  total_amount_of_fines_in_dollars: { type: Number },
  number_of_payment_denials: { type: Number },
  total_number_of_penalties: { type: Number },
  location: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  geoLocation: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        index: "2dsphere",
      },
    },
  geocoding_footnote: { type: String },
  processing_date: { type: Date },
}, { timestamps: true });
NursingFacilitySchema.index({ geoLocation: "2dsphere" });



const NursingFacility = mongoose.model<INursingFacility>(
  "NursingFacility",
  NursingFacilitySchema
);

export default NursingFacility;