import mongoose, { Document, Schema } from "mongoose";
import bcrypt from "bcryptjs";

export interface IUser extends Document {
    name?: string; // Made optional based on your schema definition
    email: string;
    password: string;
    role: 'user' | 'admin';             
    comparePassword: (candidatePassword: string) => Promise<boolean>;
}

const userSchema = new Schema<IUser>(
    {
        name: { type: String, required: false },
        email: { type: String, required: true, unique: true },
        // select: false ensures Mongoose won't return the password unless explicitly requested
        password: { type: String, required: true, select: false }, 
        role: { type: String, enum: ["user", "admin"], default: "user" },
    },
    { timestamps: true }
);

// Hash password before saving (Mongoose pre-save hook)
userSchema.pre<IUser>("save", async function (next) {
    // Only hash if the password field is new or has been modified
    if (!this.isModified("password")) return next();
    
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Compare password (Mongoose custom instance method)
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
    // Check if the document has a password (it will if select('+password') was used)
    if (!this.password) return false; 
    
    // bcrypt.compare expects a string (plain text) and a string (hashed)
    return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.model<IUser>("User", userSchema);